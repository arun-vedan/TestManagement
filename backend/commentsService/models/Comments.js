const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

const CommentsSchema = new mongoose.Schema({
    id: {
        type: Number,
        unique: true,
    },
    comments: {
        type: String,
        required: [true, 'Please add a Comment']
    },
    moduleId:{
        type: Number,
        required: [true, 'Module Id is mandatory']
    },
    status:{
        type: Number,
        default:1,
        required: [true, 'Status is mandatory']
    },
    isEdited:{
        type: Number,
        default:0,
    },
    typeId:{
        type: String,
        required: [true, 'Type Id is mandatory']
    },
    // WP-115 — tenant scope. The field already existed with its `required`
    // COMMENTED OUT, so nothing ever set it: all 166 existing comments carry
    // no projectId at all. Same class as folderService's
    // required-but-unenforced field (WP-113) — present enough to pass a grep,
    // absent enough to guarantee nothing.
    //
    // Now required + indexed. Existing documents are backfilled by
    // shared/scripts/backfillCommentProjectId.mongo.js, which derives each
    // comment's project from the entity it is attached to (typeId + moduleId)
    // rather than assuming one.
    projectId:{
        type: Number,
        required: [true, 'Project Id is mandatory'],
        index: true
    },
    createdBy:{ type: String },
    updatedBy: { type: String },
    createdByName:{ type: String },
    updatedByName:{type: String}
    
},
    {
        timestamps: true
    }
)
// WP-115 — a comment thread is always fetched for one entity: the scoped list
// query is (projectId, moduleId, typeId).
CommentsSchema.index({ projectId: 1, moduleId: 1, typeId: 1 });

CommentsSchema.pre('save', async function (next) {
    if (!this.isNew) {
        // If not a new document, move to the next middleware
        return next();
    }

    try {
        // WP-020c: atomic counter (was a read-then-write race, see
        // backend/shared/service-core/sequence.js for why).
        this.id = await getNextSequence(this.constructor.db, 'comment');
        return next();
    } catch (error) {
        return next(error);
    }
});
module.exports = mongoose.model('Comments', CommentsSchema);