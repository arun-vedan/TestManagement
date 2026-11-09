const mongoose = require('mongoose');

// WP-143 — who is who, across two identity systems.
//
// This is the part the plan calls "the most commonly underestimated part of any
// Jira integration", and the reason is a single fact: Jira Cloud identifies
// people by `accountId` and by nothing else. Not email, not username. Our
// `assignedTo` holds a Keycloak `sub`. There is no derivation between the two,
// so the correspondence has to be stored, and somebody has to establish it.
//
// WHY THE MAPPING IS PER-PROJECT, not global. An `accountId` is specific to one
// Jira SITE. Two srckube projects may be connected to different Jira sites
// (WP-142 stores the connection per project), where the same human has
// different accountIds. A global mapping would resolve one project's assignee
// to another site's account and quietly assign the wrong person -- or nobody.
//
// WHY EMAIL IS NOT THE KEY. It is tempting, and it is wrong twice over:
// Atlassian hides `emailAddress` whenever the account's privacy setting says
// so (the default on many sites), and a person's email can change on either
// side without their identity changing. Email is used only to SUGGEST a
// mapping a human then confirms; nothing resolves through it at run time.

const JiraUserMappingSchema = new mongoose.Schema(
  {
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },

    // Keycloak `sub` — what assignedTo holds throughout this product.
    keycloakSub: {
      type: String,
      required: [true, 'keycloakSub is required'],
      trim: true
    },

    jiraAccountId: {
      type: String,
      required: [true, 'jiraAccountId is required'],
      trim: true
    },

    // Captured at mapping time so a list can be rendered without calling Jira
    // for every row. Deliberately a cache of a display field, not a source of
    // truth: if someone is renamed in Jira this goes stale, which is harmless,
    // whereas calling Jira once per row to avoid that would make the settings
    // screen slow and dependent on Jira being up.
    jiraDisplayName: { type: String },
    jiraEmailAddress: { type: String, default: null },

    createdBy: { type: String },
    updatedBy: { type: String }
  },
  { timestamps: true }
);

// One Keycloak identity maps to at most one Jira account per project.
JiraUserMappingSchema.index({ projectId: 1, keycloakSub: 1 }, { unique: true });

// And one Jira account is claimed by at most one Keycloak identity per project.
//
// Enforced rather than merely preferred, because WP-144 has to resolve in BOTH
// directions: forward to assign a Jira issue, and reverse to render a linked
// issue's Jira assignee as a person this product knows. Two subs mapped to one
// accountId makes the reverse lookup ambiguous, and an ambiguous answer there
// would be resolved arbitrarily -- showing the wrong colleague's name against
// a Jira issue, which is worse than showing none.
JiraUserMappingSchema.index({ projectId: 1, jiraAccountId: 1 }, { unique: true });

JiraUserMappingSchema.methods.toPublic = function toPublic() {
  return {
    projectId: this.projectId,
    keycloakSub: this.keycloakSub,
    jiraAccountId: this.jiraAccountId,
    jiraDisplayName: this.jiraDisplayName || null,
    jiraEmailAddress: this.jiraEmailAddress || null,
    updatedAt: this.updatedAt,
    updatedBy: this.updatedBy || null
  };
};

module.exports = mongoose.model('JiraUserMapping', JiraUserMappingSchema);
