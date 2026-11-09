const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

const IssueStatusSchema = new mongoose.Schema({
    id: {
        type: Number,
        unique: true,
    },
    istatus: {
        type: String,
        required: [true, 'Please add a status name']
    },
    // ids of the statuses this status can transition from
    parentId: {
        type: [Number],
        default: []
    },
    moduleId: {
        type: Number
    },
    // WP-116 — tenant scope. The field existed but was optional and no
    // controller ever referenced it, so the defect-status vocabulary was
    // effectively global: every tenant shared one set of statuses and one
    // transition graph, and any authenticated user could rename or delete a
    // status for everybody.
    //
    // Now required + indexed. See shared/scripts/seedProjectStatuses.mongo.js
    // for why scoping this needed a SEEDING step as well: only project 1 held
    // the 8 statuses, so scoping alone would have left every other project
    // unable to transition a defect at all.
    projectId: {
        type: Number,
        required: [true, 'Project Id is mandatory'],
        index: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId
    }
},
    {
        timestamps: true
    }
)
// WP-116 — the vocabulary is always read for one project (and, where it
// matters, one module), which is the shape defectService's validation fetch
// and the frontend's DefectStatus.tsx both use.
IssueStatusSchema.index({ projectId: 1, moduleId: 1 });

IssueStatusSchema.pre('save', async function (next) {
    if (!this.isNew) {
        return next();
    }

    try {
        // WP-020c: atomic counter (was a read-then-write race, see
        // backend/shared/service-core/sequence.js for why).
        this.id = await getNextSequence(this.constructor.db, 'issuestatus');
        return next();
    } catch (error) {
        return next(error);
    }
});
module.exports = mongoose.model('IssueStatus', IssueStatusSchema, 'staus');
