const mongoose = require('mongoose');
const { ORG_ROLES } = require('@srckube/service-core');

// WP-110 — one organization membership entry. Imports ORG_ROLES from the
// shared permissions module (not a local copy) for the same reason
// Project.members[] imports ROLES: the enum and the permission matrix that
// interprets it must be one source of truth.
const OrgMemberSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: [true, 'member userId is required']
    },
    role: {
      type: String,
      enum: ORG_ROLES,
      required: [true, 'member role is required']
    }
  },
  { _id: false, timestamps: { createdAt: 'addedAt', updatedAt: false } }
);

// WP-020: Organization is the top-level tenant boundary. ADR-002 option B
// (see EXECUTION_LOG.md WP-020 entry) homes this in userService, evolving
// it toward the "Identity & Access" target service, rather than standing up
// a new container. Multi-org UI (an org switcher) is explicitly deferred —
// this model exists now because Project.organizationId needs somewhere
// real to point, not because multiple organizations are in active use yet.
const OrganizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add an organization name'],
      trim: true
    },
    key: {
      type: String,
      required: [true, 'Please add an organization key'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9-]+$/, 'Key may only contain lowercase letters, numbers and hyphens']
    },
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active'
    },
    createdBy: {
      type: String,
      required: [true, 'createdBy is required']
    },
    // WP-110 — organization membership. This is the field whose absence made
    // GET /api/v1/projects impossible to scope: there was no way to ask "which
    // organizations does this caller belong to", so the list had to return
    // every project to everyone.
    //
    // Shape mirrors Project.members[] exactly (same subdocument style, same
    // `addedAt`-from-timestamps trick, role enum imported from the shared
    // permissions module rather than re-declared) so the two membership
    // arrays cannot drift apart in structure. The role enum is ORG_ROLES,
    // NOT the project ROLES -- see shared/service-core/permissions.js on why
    // those are deliberately separate lists.
    members: {
      type: [OrgMemberSchema],
      default: []
    }
  },
  { timestamps: true }
);

// WP-110: getProjects resolves the caller's organizations on every list
// request (Organization.find({ 'members.userId': sub })), so this is the index
// that query runs on.
OrganizationSchema.index({ 'members.userId': 1 });

module.exports = mongoose.model('Organization', OrganizationSchema);
