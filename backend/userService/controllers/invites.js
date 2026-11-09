const {
  asyncHandler,
  ErrorResponse,
  ROLES,
  audit,
  sendMail,
  isMailConfigured,
  missingConfig
} = require('@srckube/service-core');
const Invite = require('../models/Invite');
const { Project } = require('../models/Project');
const { keycloakUserByEmail } = require('../utils/keycloakAdmin');
const { requiresAdminActor } = require('./projects');

// WP-132 — invite a teammate by email.
//
// The pre-existing path was addMember(), which takes a raw Keycloak `sub`. That
// only works for someone who already has an account AND whose UUID the admin
// somehow knows; the product never displayed one. This adds the path for
// everyone else: address an invite to an email that may never have signed up.
//
// addMember() is NOT replaced. It remains the right call for an identity that
// already exists, and the invite flow converges on the same members[] array,
// the same role enum, and the same escalation guard.

const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;

function appBaseUrl() {
  // The invite link has to point at something the RECIPIENT can open, which is
  // the frontend, not this API. There was no public-base-URL variable in this
  // codebase before WP-132 (verified), so one is introduced here with a
  // local-dev default rather than guessing per request from Host/Referer —
  // those are attacker-controlled on a public endpoint and would turn an
  // invite mail into an open redirect.
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function inviteUrl(rawToken) {
  return `${appBaseUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}

function actorSub(req) {
  return req.kauth?.grant?.access_token?.content?.sub;
}

function publicInvite(inv) {
  // tokenHash is select:false, but being explicit here means a future change to
  // the schema cannot start leaking it through this shape by accident.
  return {
    _id: inv._id,
    email: inv.email,
    projectId: inv.projectId,
    organizationId: inv.organizationId,
    role: inv.role,
    status: inv.status,
    expiresAt: inv.expiresAt,
    invitedBy: inv.invitedBy,
    acceptedBy: inv.acceptedBy,
    acceptedAt: inv.acceptedAt,
    createdAt: inv.createdAt
  };
}

// Customer-visible product name. Internal identifiers stay `srckube`.
const PRODUCT_NAME = 'vedan';

function inviteMail({ project, role, url, expiresAt }) {
  const name = project.name || `project ${project.id}`;
  const expires = expiresAt.toUTCString();
  const text = [
    `You have been invited to join "${name}" on ${PRODUCT_NAME} as ${role}.`,
    '',
    `Accept the invitation: ${url}`,
    '',
    `This invitation expires on ${expires}.`,
    'If you do not have an account yet, you will be asked to create one first;',
    'use this same email address so the invitation can be matched to you.',
    '',
    'If you were not expecting this, you can ignore this message.'
  ].join('\n');
  return { subject: `You have been invited to ${name} on ${PRODUCT_NAME}`, text };
}

// @desc      Invite someone to a project by email
// @route     POST /api/v1/projects/:id/invites
// @access    Private (Keycloak), requireProjectAction('manage_members')
exports.createInvite = asyncHandler(async (req, res, next) => {
  const { email, role } = req.body;
  if (!email || !role) {
    return next(new ErrorResponse('email and role are required', 400));
  }
  if (!ROLES.includes(role)) {
    return next(new ErrorResponse(`role must be one of: ${ROLES.join(', ')}`, 400));
  }

  const project = req.project; // set by requireProjectAction()

  // Same escalation guard addMember() applies, imported rather than restated.
  // Without it, manage_members would let a manager invite someone as 'admin'
  // and escalate through the invite path the moment that invite is accepted —
  // the exact hole WP-022 closed for the direct path.
  if (project.members.length > 0 && requiresAdminActor(role) && req.projectRole !== 'admin') {
    return next(new ErrorResponse("Only an existing admin may invite someone as 'admin'", 403));
  }

  const normalisedEmail = String(email).toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
    return next(new ErrorResponse('email must be a valid address', 400));
  }

  let days = DEFAULT_EXPIRY_DAYS;
  if (req.body.expiresInDays !== undefined) {
    days = Number(req.body.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
      return next(new ErrorResponse(`expiresInDays must be between 1 and ${MAX_EXPIRY_DAYS}`, 400));
    }
  }

  // Refuse BEFORE writing anything if we cannot send. Persisting an invite we
  // cannot deliver leaves an admin waiting on a mail that was never sent, with
  // a pending row that looks correct. Checked here, and the send below is also
  // awaited, so success is never reported for an unsent invite.
  if (!isMailConfigured()) {
    return next(
      new ErrorResponse(
        `Cannot send invitations: mail is not configured (missing ${missingConfig().join(', ')})`,
        503
      )
    );
  }

  // "Already a member" is a more useful answer than an invite that resolves to
  // nothing. Only reached when the address already has an account.
  const existingAccount = await keycloakUserByEmail(normalisedEmail);
  if (existingAccount && project.members.some((m) => m.userId === existingAccount.id)) {
    return next(new ErrorResponse(`${normalisedEmail} is already a member of this project`, 409));
  }

  // A second invite to the same address SUPERSEDES the first rather than being
  // rejected, so "resend" and "I sent the wrong role" both work without the
  // admin having to find and revoke the old one. The old token stops working
  // immediately, which is also what someone correcting a mistaken role expects.
  const superseded = await Invite.updateMany(
    { projectId: project.id, email: normalisedEmail, status: 'pending' },
    { $set: { status: 'revoked', revokedBy: actorSub(req), revokedAt: new Date() } }
  );

  const { raw, hash } = Invite.generateToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const invite = await Invite.create({
    email: normalisedEmail,
    projectId: project.id,
    organizationId: project.organizationId,
    role,
    tokenHash: hash,
    expiresAt,
    status: 'pending',
    invitedBy: actorSub(req)
  });

  const url = inviteUrl(raw);
  try {
    const { subject, text } = inviteMail({ project, role, url, expiresAt });
    await sendMail({ to: normalisedEmail, subject, text });
  } catch (err) {
    // The invite row would otherwise outlive a failed send and show as pending
    // forever. Removing it keeps the list honest: every pending invite is one
    // whose mail the relay accepted.
    await Invite.deleteOne({ _id: invite._id });
    return next(new ErrorResponse(`Invitation could not be sent: ${err.message}`, 502));
  }

  await audit(req, {
    entityType: 'project_invite',
    entityId: String(invite._id),
    action: 'member_invite',
    after: { email: normalisedEmail, role, expiresAt },
    projectId: project.id,
    organizationId: project.organizationId
  });

  res.status(201).json({
    success: true,
    // The raw token is returned ONCE, to the admin who created it, so they can
    // pass the link along by another channel if mail is unreliable — which it
    // currently is for inbox placement (WP-130's unresolved SPF/DKIM clause).
    // It is never retrievable again: only the hash is stored.
    data: publicInvite(invite),
    inviteUrl: url,
    supersededPending: superseded && superseded.n !== undefined ? superseded.n : superseded.nModified || 0
  });
});

// @desc      List a project's invitations
// @route     GET /api/v1/projects/:id/invites
// @access    Private (Keycloak), requireProjectAction('manage_members')
exports.listInvites = asyncHandler(async (req, res) => {
  const filter = { projectId: req.project.id };
  if (req.query.status) {
    filter.status = req.query.status;
  }
  const invites = await Invite.find(filter).sort({ createdAt: -1 });

  // 'pending' in the database is not the same as "still usable": an expired row
  // keeps status 'pending' because expiry is a function of time, not a write.
  // Surfacing `expired` separately stops the UI from offering an accept that
  // would be refused.
  const data = invites.map((inv) => ({ ...publicInvite(inv), expired: !inv.isAcceptable() && inv.status === 'pending' }));
  res.status(200).json({ success: true, count: data.length, data });
});

// @desc      Revoke a pending invitation
// @route     DELETE /api/v1/projects/:id/invites/:inviteId
// @access    Private (Keycloak), requireProjectAction('manage_members')
exports.revokeInvite = asyncHandler(async (req, res, next) => {
  const invite = await Invite.findOne({ _id: req.params.inviteId, projectId: req.project.id });
  if (!invite) {
    return next(new ErrorResponse('Invitation not found', 404));
  }
  if (invite.status === 'accepted') {
    return next(
      new ErrorResponse('That invitation was already accepted; remove the member instead', 409)
    );
  }
  if (invite.status === 'revoked') {
    // Idempotent: revoking twice is not an error worth failing a UI over.
    return res.status(200).json({ success: true, data: publicInvite(invite) });
  }

  invite.status = 'revoked';
  invite.revokedBy = actorSub(req);
  invite.revokedAt = new Date();
  await invite.save();

  await audit(req, {
    entityType: 'project_invite',
    entityId: String(invite._id),
    action: 'member_invite_revoke',
    before: { email: invite.email, role: invite.role, status: 'pending' },
    after: { email: invite.email, role: invite.role, status: 'revoked' },
    projectId: invite.projectId,
    organizationId: invite.organizationId
  });

  res.status(200).json({ success: true, data: publicInvite(invite) });
});

// @desc      Accept an invitation
// @route     POST /api/v1/invites/accept
// @access    Private (Keycloak) — authenticated, but deliberately NOT
//            project-scoped: the caller is not a member yet, which is the
//            whole point. requireProjectScope() here would 403 every accept.
exports.acceptInvite = asyncHandler(async (req, res, next) => {
  const { token } = req.body;
  if (!token) {
    return next(new ErrorResponse('token is required', 400));
  }

  const claims = req.kauth?.grant?.access_token?.content || {};
  const callerSub = claims.sub;
  const callerEmail = claims.email ? String(claims.email).toLowerCase() : null;
  if (!callerSub) {
    return next(new ErrorResponse('Not authenticated', 401));
  }
  if (!callerEmail) {
    return next(
      new ErrorResponse('Your account has no email address, so an invitation cannot be matched to it', 403)
    );
  }

  const invite = await Invite.findOne({ tokenHash: Invite.hashToken(token) }).select('+tokenHash');
  if (!invite) {
    // Deliberately indistinguishable from a wrong token: a precise message
    // ("no such invite" vs "expired") would let someone probe for valid tokens.
    return next(new ErrorResponse('That invitation link is not valid', 404));
  }

  // THE BINDING. Without this check, an invite link is a bearer token anyone
  // can redeem — forwarded mail, a shared screenshot, a mailing list archive —
  // and they would land in the project at the invited role. The invite is
  // addressed to an email, so acceptance requires the caller to actually hold
  // that address, proven by the email claim in their own verified token rather
  // than by a lookup we perform on their behalf.
  if (callerEmail !== invite.email) {
    return next(
      new ErrorResponse('This invitation was sent to a different email address', 403)
    );
  }
  // An unverified address proves nothing: anyone can type someone else's email
  // at signup. WP-130 makes VERIFY_EMAIL a realm requirement, so a real signup
  // is already verified by the time it can log in; this is the backstop for
  // accounts created by other means.
  if (claims.email_verified === false) {
    return next(
      new ErrorResponse('Verify your email address before accepting an invitation', 403)
    );
  }

  if (invite.status === 'accepted') {
    return next(new ErrorResponse('That invitation has already been used', 410));
  }
  if (invite.status === 'revoked') {
    return next(new ErrorResponse('That invitation was revoked', 410));
  }
  if (!invite.isAcceptable()) {
    return next(new ErrorResponse('That invitation has expired', 410));
  }

  const project = await Project.findOne({ id: invite.projectId });
  if (!project) {
    return next(new ErrorResponse('The project for this invitation no longer exists', 410));
  }
  if (project.status === 'archived') {
    return next(new ErrorResponse('The project for this invitation has been archived', 410));
  }

  const existing = project.members.find((m) => m.userId === callerSub);
  if (!existing) {
    project.members.push({ userId: callerSub, role: invite.role });
  } else if (existing.role !== invite.role) {
    // Already a member at a different role, which happens when someone is
    // added directly and invited around the same time.
    //
    // The invite only ever RAISES a role, never lowers one. Accepting a
    // 'viewer' invite must not silently demote an existing admin: the person
    // clicking the link would be downgrading themselves with no warning, and a
    // stale invite sent before a promotion would undo it.
    //
    // ROLES is ordered most-privileged-first, so a lower index is a higher
    // privilege. That ordering is incidental to the array's purpose, so it is
    // converted to an explicit rank here rather than compared inline — a
    // future reorder of ROLES must not silently turn this into a demotion.
    const privilegeRank = (r) => ROLES.indexOf(r); // 0 = admin, highest
    if (privilegeRank(invite.role) < privilegeRank(existing.role)) {
      existing.role = invite.role;
    }
  }
  await project.save();

  invite.status = 'accepted';
  invite.acceptedBy = callerSub;
  invite.acceptedAt = new Date();
  await invite.save();

  await audit(req, {
    entityType: 'project_member',
    entityId: callerSub,
    action: 'member_add',
    after: { userId: callerSub, role: invite.role, via: 'invite', inviteId: String(invite._id) },
    projectId: project.id,
    organizationId: project.organizationId
  });

  res.status(200).json({
    success: true,
    data: { projectId: project.id, projectName: project.name, role: invite.role }
  });
});
