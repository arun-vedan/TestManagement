const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

const ModuleSchema = new mongoose.Schema({
    id: {
        type: Number,
        unique: true,
    },
    moduleName: {
        type: String,
        required: [true, 'Please add a Module name']
    },
    // WP-114 — tenant scope. Additive (GR-7).
    //
    // A DESIGN CONCERN RECORDED RATHER THAN SILENTLY DECIDED: module ids are
    // also a product-wide taxonomy. frontend/src/workbench/modules.ts declares
    // `ModuleId = 1|2|3|4|5|6` with hardcoded slugs, labels, icons and routing,
    // and linkIssueService/controllers/linkIssue.js hardcodes
    // `MODULE = { TEST_CASE: 1, REQUIREMENT: 2 }`. So "which modules exist" is
    // not actually per-tenant today -- it is compiled in.
    //
    // Scoping is still the right call for THIS service, because what it
    // exposes is a writable CRUD surface over those rows: before WP-114 any
    // authenticated user could rename or delete the global `testcaserepo` row
    // for everybody. That is the hole being closed. But if modules are ever
    // meant to be genuinely per-project (the unbuilt Settings surface in
    // frontend/src/Pages/settings/ReservedTab.tsx), the hardcoded taxonomy has
    // to move too, and that is a product decision no WP has taken. Flagged in
    // EXECUTION_LOG.md's WP-114 entry.
    projectId: {
        type: Number,
        required: [true, 'Project Id is mandatory'],
        index: true
    },
    // NOTE (WP-114, not changed here): these are declared as ObjectId, which is
    // the exact defect folderService's __tests__/folder.test.js was written to
    // guard against -- a Keycloak `sub` is a UUID string, never a 24-hex
    // ObjectId, so any create that actually sends one cast-fails. It does not
    // bite today because no caller sends createdBy to this service (nothing
    // calls it at all), which is also why it was never noticed. Recorded as a
    // candidate WP rather than fixed here: changing a field's type is a
    // migration, not a scoping change.
    // WP-101 follow-up: was mongoose.Schema.Types.ObjectId. A Keycloak `sub`
    // is a UUID string, never a 24-hex ObjectId, so any create that actually
    // sent one would cast-fail -- the exact defect folderService's
    // __tests__/folder.test.js was written to guard against. String matches
    // every other service (testRepo, requirement, folder, defect) and matches
    // what the identity actually is.
    //
    // No migration needed, verified rather than assumed: the only two
    // documents in this collection hold real ObjectIds from the pre-Keycloak
    // era (2024), which Mongoose hydrates as their hex strings under a String
    // path. Both also carry NO projectId at all, so they are already
    // invisible to every scoped route -- recorded as legacy debris in
    // EXECUTION_LOG.md rather than touched here.
    createdBy: { type: String },
    updatedBy: { type: String }
    
},
    {
        timestamps: true
    }
)
ModuleSchema.pre('save', async function (next) {
    if (!this.isNew) {
        // If not a new document, move to the next middleware
        return next();
    }

    try {
        // WP-020c: atomic counter (was a read-then-write race, see
        // backend/shared/service-core/sequence.js for why).
        this.id = await getNextSequence(this.constructor.db, 'module');
        return next();
    } catch (error) {
        return next(error);
    }
});
module.exports = mongoose.model('Module', ModuleSchema);