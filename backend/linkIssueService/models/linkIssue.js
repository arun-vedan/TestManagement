const mongoose = require("mongoose");
const { getNextSequence } = require("@srckube/service-core");
const { EXTERNAL_PROVIDERS } = require('../utils/externalLink');

const linkIssueSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
    },
    // WP-111 — tenant scope. Additive (GR-7): existing documents are
    // backfilled by shared/scripts/backfillLinkIssueProjectId.mongo.js, which
    // derives each link's project from the entities it connects rather than
    // assuming one. New documents get it stamped server-side from
    // req.projectScope, set by requireProjectScope() -- never trusted from the
    // client body, the same rule testRepoService/requirementService/
    // defectService already follow.
    //
    // This is also what retires the DEFAULT_PROJECT_ID = '1' shim that
    // controllers/linkIssue.js carried on its two coverage endpoints. WP-104
    // audited that shim and deliberately left it: unlike reportingService's
    // sibling guard, its premise was still TRUE, because this service genuinely
    // had no scoping and the endpoints had no per-request project to forward.
    // Now they do.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    linkId:{
        type:String,
        unique:true,
    },
    sourceId:{
        type:String,
    },
    destinationId: {
      type: String,
      required: [true, "Please provide Ticket Details to link"],
    },
    summary:{
      type: String,
    },
    srcSummary:{
      type: String,
    },
    srcModule:{
      type: Number,
      required: [true, "Please provide Ticket Details to link"],
    },
    destinationModule:{
      type: Number,

    },
    // Sprint 2.2 (PB-05): typed relationship between the two linked items.
    // 'relates-to' is a safe universal default (unlike Sprint 2.1's status
    // default bug — there's no "wrong" neutral value here, every new link
    // really is just "related" unless the user says otherwise), but existing
    // pre-Sprint-2.2 links still need an explicit backfill (not just this
    // default) so a stored-field query like { linkType: 'relates-to' } finds
    // them — a schema default only affects hydration of missing fields, not
    // what's actually queryable in the database.
    linkType: {
      type: String,
      enum: ['tests', 'blocks', 'duplicates', 'relates-to'],
      default: 'relates-to',
    },
    // WP-141 — present only on an external-issue link (destinationModule
    // EXTERNAL_MODULE, utils/externalLink.js). provider + key identify the
    // issue; status/fetchedAt are a server-written cache of the provider's
    // own data (WP-144 fills them), never accepted from a client.
    external: {
      type: new mongoose.Schema(
        {
          provider: { type: String, enum: EXTERNAL_PROVIDERS, required: true },
          key: { type: String, required: true },
          status: { type: String },
          fetchedAt: { type: Date },

          // WP-144 — the rest of the display cache WP-141 reserved room for.
          // Server-written only, never accepted from a client (utils/
          // externalLink.js strips these from any request body).
          //
          // Cached so a linked issue still RENDERS when Jira is unreachable,
          // labelled stale, instead of showing a broken row. That is the
          // acceptance, and it is why these live on the link rather than
          // being fetched on demand and discarded.
          summary: { type: String },
          // Jira's own status NAMES are workflow-configurable per project
          // ("To Do" vs "Backlog" vs "Selected for Development"), so a UI
          // cannot colour a badge from them. statusCategory is one of three
          // fixed values and is what a badge should key off.
          statusCategory: { type: String },
          issueType: { type: String },
          assigneeAccountId: { type: String },
          assigneeDisplayName: { type: String },
          // Set when Jira answered but did not return this key -- deleted,
          // moved, or no longer visible to the configured account. Rendered
          // as "no longer in Jira" rather than as a blank row, and
          // deliberately distinct from "we could not reach Jira".
          missing: { type: Boolean }
        },
        { _id: false }
      ),
      default: undefined
    },
    createdBy: {
      type: String,
    },
    updatedBy: { type: String },
  },
  {
    timestamps: true, 
  }
);
// WP-111: the uniqueness constraint becomes per-project. It was
// {sourceId, destinationId} globally unique, which across tenants is wrong in
// both directions -- project B could not create a link between ids that
// project A had already linked (a cross-tenant write collision, visible to the
// user as a duplicate-key error about a link they cannot see), and the
// constraint was meaningless as a tenant-level guarantee anyway. Scoped by
// projectId it means what it was intended to mean: one link per pair, within a
// project.
linkIssueSchema.index({ projectId: 1, sourceId: 1, destinationId: 1 }, { unique: true })
linkIssueSchema.pre(['findOneAndUpdate', 'findByIdAndUpdate', 'updateOne'], function(next) {
  this.update({}, { $inc: { __v: 1 } }); // Automatically increment the __v field
  next();
});
linkIssueSchema.pre("save", async function (next) {
  if (!this.isNew) {
    // If not a new document, move to the next middleware
    return next();
  }

  try {
    // Find the highest existing id and increment by 1
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'linkissue');

    this.id = nextId;
    this.linkId="link-"+nextId
    return next();
  } catch (error) {
    return next(error);
  }
});


module.exports = mongoose.model("linkIssue", linkIssueSchema);
