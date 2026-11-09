const nodemailer = require('nodemailer');

// WP-132 — the application's own outbound mail.
//
// WHY THIS EXISTS AT ALL. Before this, nothing in the backend could send an
// email. WP-130 configured SMTP *inside the Keycloak realm*, which only sends
// Keycloak's own templated messages (verify email, reset password). Those
// cannot carry "you were invited to project X as a manager" — Keycloak knows
// nothing about projects or roles. notificationService is an in-app
// notification store (a Mongo model and a consumer); it has no SMTP client and
// never did. So an invite mail needed a transport, and this is it.
//
// It reads the same SMTP_* variables WP-130 already put in backend/.env, so
// there is one set of credentials for the product rather than two.
//
// DESIGN POSTURE: FAIL LOUDLY, NEVER SILENTLY.
//
// The failure mode that matters here is not "the mail bounced", it is "the
// product reported success and the mail was never sent". An invite that was
// silently dropped looks identical, to the admin who sent it, to one sitting
// unread in someone's inbox: they wait, nothing happens, and there is nothing
// to look at. service-core's audit() deliberately swallows its own errors
// because an audit write must never fail a business operation; this is the
// opposite case, and is deliberately NOT modelled on it. A caller that cannot
// send the invite mail must find out.
//
// So: isMailConfigured() lets a caller check before it commits a database
// write, and sendMail() rejects rather than resolving falsely.

let cachedTransport;

const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];

function missingConfig() {
  return REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
}

function isMailConfigured() {
  return missingConfig().length === 0;
}

function getTransport() {
  const missing = missingConfig();
  if (missing.length) {
    throw new Error(
      `Cannot send mail: missing ${missing.join(', ')}. These live in backend/.env ` +
        '(see .env.example) and are the same credentials WP-130 configured for Keycloak.'
    );
  }

  if (!cachedTransport) {
    const port = parseInt(process.env.SMTP_PORT, 10);
    cachedTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this
      // backwards produces a connection that hangs rather than an error, so it
      // is derived from the port instead of being a separate flag someone can
      // set inconsistently.
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    });
  }
  return cachedTransport;
}

// Overridable for tests, so a suite can assert what WOULD be sent without
// opening a socket to the relay. Set SMTP_TRANSPORT_OVERRIDE to an object with
// a sendMail(message) method.
function resolveTransport() {
  if (process.env.NODE_ENV === 'test' && global.__SRCKUBE_MAIL_SINK__) {
    return global.__SRCKUBE_MAIL_SINK__;
  }
  return getTransport();
}

async function sendMail({ to, subject, text, html }) {
  if (!to || !subject || (!text && !html)) {
    throw new Error('sendMail requires to, subject, and one of text/html');
  }

  const from = process.env.SMTP_FROM_NAME
    ? `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM}>`
    : process.env.SMTP_FROM;

  const info = await resolveTransport().sendMail({
    from,
    to,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(process.env.SMTP_REPLY_TO ? { replyTo: process.env.SMTP_REPLY_TO } : {})
  });

  // accepted/rejected come from the SMTP conversation. A relay can accept the
  // message for some recipients and reject others in the same transaction, in
  // which case nodemailer resolves rather than throws — so a caller that only
  // checked for an exception would report success for a rejected address.
  if (info && Array.isArray(info.rejected) && info.rejected.length > 0) {
    throw new Error(`Mail relay rejected ${info.rejected.join(', ')}`);
  }
  return info;
}

// KNOWN LIMITATION, recorded rather than hidden (WP-130's open clause).
// SMTP_FROM is currently a @gmail.com address relayed through Brevo. Brevo is
// not authorised in gmail.com's SPF record and cannot DKIM-sign for a domain it
// does not control, so these messages fail SPF/DKIM alignment and land in spam
// even when the relay accepts them. Mechanically the send succeeds; delivery to
// the inbox needs a sender domain the operator owns. Nothing in this module can
// fix that, and it does not pretend to.
module.exports = { sendMail, isMailConfigured, missingConfig };
