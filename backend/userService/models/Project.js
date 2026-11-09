const mongoose = require('mongoose');

// WP-022: ROLES now comes from @srckube/service-core's permissions module
// (backend/shared/service-core/permissions.js) instead of a local literal
// -- that file is the single source of truth for RBAC across every
// service, so Project.members' schema enum can never drift from the role
// x action matrix that actually enforces those roles.
const { ROLES, getNextSequence } = require('@srckube/service-core');

const MemberSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: [true, 'Member userId is required']
    },
    role: {
      type: String,
      enum: ROLES,
      required: [true, 'Member role is required'],
      default: 'viewer'
    }
  },
  { _id: false, timestamps: { createdAt: 'addedAt', updatedAt: false } }
);

// WP-020 discovery (see EXECUTION_LOG.md): every real document across
// folders/fields/issuestatus that carries a `projectId` (Number) today
// holds the literal value 1, traced to a single hardcoded
// `let projectId = 1` in frontend/src/Components/folderStructure/
// folderStructure.tsx. There was no pre-existing backend "project"
// persistence — the old frontend project-CRUD UI called routes
// (/api/v1/project, /api/v1/deployments, /api/v1/service, /api/v1/ingress)
// that do not exist in Kong or in any backend service.
//
// `id` here is a legacy-compatible auto-incrementing Number (same pattern
// as moduleService's Module.id), NOT the Mongo _id, so the backfilled
// default project can be given id=1 and stay consistent with that existing
// numeric convention for any future consumer that joins on it. This WP
// does not modify fieldsService/folderService/statusService/commentsService
// (out of scope) or their documents — this is purely an additive new
// collection.
const ProjectSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true
    },
    name: {
      type: String,
      required: [true, 'Please add a project name'],
      trim: true
    },
    key: {
      type: String,
      required: [true, 'Please add a project key'],
      trim: true
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'organizationId is required']
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
    // Anchor for WP-022 RBAC: { userId, role }[] where role is one of ROLES.
    members: {
      type: [MemberSchema],
      default: []
    }
  },
  { timestamps: true }
);

// A project key is unique within its organization, not globally.
ProjectSchema.index({ organizationId: 1, key: 1 }, { unique: true });

ProjectSchema.pre('save', async function (next) {
  if (!this.isNew || this.id !== undefined) {
    return next();
  }
  try {
    // WP-020c: atomic counter (was a read-then-write race -- this exact
    // model was the original finding: two concurrent creates could read
    // the same max and both write max+1, so the second insert died on the
    // `id` unique index and surfaced to the caller as a 400. See
    // backend/shared/service-core/sequence.js for why a counter, and
    // EXECUTION_LOG.md's WP-020c report for the concurrency proof).
    this.id = await getNextSequence(this.constructor.db, 'project');
    return next();
  } catch (err) {
    return next(err);
  }
});

module.exports = { Project: mongoose.model('Project', ProjectSchema), ROLES };
