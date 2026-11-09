const mongoose = require('mongoose');

// WP-142 — one Jira connection per project.
//
// WHY THE TOKEN IS SEALED RATHER THAN STORED. A Jira API token carries its
// account's full permissions on that site; the one this was built against has
// ADMINISTER_PROJECTS, so it is an admin credential, not a read-only
// integration key. Stored in plaintext, a mongodump or read access to this one
// collection would hand over administrative access to a customer's Jira.
//
// It goes through WP-140's encryptSecret with the context
// `jira:project:<projectId>`. That context is passed as AES-GCM additional
// authenticated data, so a sealed token is cryptographically BOUND to the
// project it belongs to: copying one tenant's encrypted token into another
// tenant's settings row produces a value that will not decrypt, rather than a
// working credential. Without the context binding, an encrypted blob is still
// portable, and the attack needs no key material at all.
//
// `select: false` keeps it out of every query that does not explicitly ask,
// so the default read path cannot leak it into an API response by omission.
const JiraConnectionSchema = new mongoose.Schema(
  {
    // One connection per project. Unique, so a double-submit upserts rather
    // than silently creating a second row that shadows the first.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      unique: true,
      index: true
    },

    // Scheme and host only. normalizeBaseUrl() in utils/jiraClient.js strips
    // the /jira/... web-UI path before anything is stored, because the REST
    // API lives at the host root and a stored path would 404 every call
    // against a URL that looks correct.
    baseUrl: {
      type: String,
      required: [true, 'baseUrl is required'],
      trim: true
    },

    // Pairs with the token for HTTP Basic. Not the account's password.
    accountEmail: {
      type: String,
      required: [true, 'accountEmail is required'],
      trim: true,
      lowercase: true
    },

    apiTokenSealed: {
      type: String,
      required: [true, 'apiTokenSealed is required'],
      select: false
    },

    // The Jira project keys this srckube project may link issues from. Checked
    // at validation time, so a key that was visible when saved and later
    // revoked shows up on the next validate rather than as a failed link.
    projectKeys: {
      type: [String],
      default: []
    },

    // What the last successful validation SAW. Kept so the settings screen can
    // show "connected as X, projects Y" without re-calling Jira on every page
    // load, and so a support question about a broken integration has a
    // last-known-good to compare against.
    lastValidatedAt: Date,
    lastValidatedBy: String,
    validatedAccountId: String,
    validatedAccountName: String,

    createdBy: { type: String },
    updatedBy: { type: String }
  },
  { timestamps: true }
);

// The shape safe to return over the API: everything except the sealed token.
// A method rather than a transform so that returning it is a deliberate act at
// each call site, and `select: false` is not the only thing standing between
// the token and a response body.
JiraConnectionSchema.methods.toPublic = function toPublic() {
  return {
    projectId: this.projectId,
    baseUrl: this.baseUrl,
    accountEmail: this.accountEmail,
    projectKeys: this.projectKeys,
    // Presence, never the value. A settings screen needs to know whether a
    // token is stored; it never needs the token.
    apiTokenConfigured: Boolean(this.apiTokenSealed),
    lastValidatedAt: this.lastValidatedAt || null,
    lastValidatedBy: this.lastValidatedBy || null,
    validatedAccountId: this.validatedAccountId || null,
    validatedAccountName: this.validatedAccountName || null,
    updatedAt: this.updatedAt,
    updatedBy: this.updatedBy || null
  };
};

module.exports = mongoose.model('JiraConnection', JiraConnectionSchema);
