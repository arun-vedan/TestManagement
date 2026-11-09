const mongoose = require('mongoose');
const crypto = require('crypto');
const { ROLES } = require('@srckube/service-core');

// WP-132 — invite a teammate by email address.
//
// Before this, adding a colleague meant pasting their raw Keycloak `sub` UUID
// into a free-text box (ProjectMembersPanel.tsx's "User id" field). That
// required the colleague to already have an account, and required the admin to
// obtain a UUID from somewhere the product never showed them.
//
// WHY THE TOKEN IS STORED AS A HASH. The token in an invite mail is a bearer
// credential: whoever holds it can join a project at a role someone else chose.
// Storing it in plaintext would mean a leaked database dump, a mongodump left
// on a laptop, or read access to this collection yields a set of working invite
// links. Only the SHA-256 is persisted; the raw token exists in the mail and in
// the response to the admin who created it, and nowhere else. This is the same
// reasoning as never storing a password, and it costs nothing here because the
// token is looked up by exact value, not searched.
//
// The role enum deliberately reuses ROLES from service-core rather than
// restating it, for the reason Project.js's MemberSchema gives: an enum copied
// here could drift from the role x action matrix that actually enforces it.
const InviteSchema = new mongoose.Schema(
  {
    // Lowercased on write. Keycloak treats email case-insensitively for login,
    // so 'Alice@x.com' and 'alice@x.com' must not be two different invites or
    // two different acceptance checks.
    email: {
      type: String,
      required: [true, 'Invite email is required'],
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invite email must be a valid address']
    },
    projectId: {
      type: Number,
      required: [true, 'Invite projectId is required']
    },
    // Denormalised from the project so an org admin can list and audit invites
    // without a join, and so a project moved between organizations cannot
    // silently carry a stale invite into a new tenant.
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'Invite organizationId is required']
    },
    role: {
      type: String,
      enum: ROLES,
      required: [true, 'Invite role is required']
    },
    tokenHash: {
      type: String,
      required: true,
      select: false
    },
    expiresAt: {
      type: Date,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'revoked'],
      default: 'pending'
    },
    // Keycloak sub of the admin who sent it.
    invitedBy: {
      type: String,
      required: true
    },
    // Keycloak sub of whoever accepted. Kept alongside the invited email
    // because they are different facts: the email says who was invited, this
    // says which identity actually claimed it.
    acceptedBy: String,
    acceptedAt: Date,
    revokedBy: String,
    revokedAt: Date
  },
  { timestamps: true }
);

// Exact-value lookup on accept.
InviteSchema.index({ tokenHash: 1 }, { unique: true });
// Listing a project's invites, and the duplicate-pending check.
InviteSchema.index({ projectId: 1, status: 1 });
InviteSchema.index({ email: 1, status: 1 });
// WP-120's rule: every tenant filter gets an index.
InviteSchema.index({ organizationId: 1, status: 1 });

// Raw token returned to the caller; only its hash is ever persisted.
InviteSchema.statics.generateToken = function generateToken() {
  // base64url: safe in a URL without encoding, which matters because this
  // travels in an invite link that mail clients will linkify.
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: InviteSchema.statics.hashToken(raw) };
};

InviteSchema.statics.hashToken = function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
};

// A single place that decides whether an invite can still be accepted, so the
// accept route and the list route cannot disagree about what "pending" means.
InviteSchema.methods.isAcceptable = function isAcceptable() {
  return this.status === 'pending' && this.expiresAt instanceof Date && this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model('Invite', InviteSchema);
