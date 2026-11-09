const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

const FolderSchema = new mongoose.Schema({
    id: {
        type: Number,
        unique: true,
    },
    folderName: {
        type: String,
        required: [true, 'Please add a Folder name']
    },
    parentFolder: {
        type: Number,
        required: [true, 'Parent folder is mandatory']
    },
    moduleId:{
        type: Number,
        required: [true, 'Module Id is mandatory']
    },
    // WP-113 — this field already existed and was already `required`, which
    // made folderService LOOK scoped while being nothing of the kind: no
    // controller referenced it, so it was taken straight from req.body on
    // create (client-supplied, never verified) and no read filtered on it at
    // all. A required-but-unenforced tenant field is worse than a missing one,
    // because the schema implies a guarantee the code never made.
    //
    // WP-113 adds the index and makes every controller derive it from
    // req.projectScope instead.
    projectId:{
        type: Number,
        required: [true, 'Project Id is mandatory'],
        index: true
    },
    createdBy: {
        type: String
    },
    updatedBy: { type: String }
},
    {
        timestamps: true
    }
)
// WP-113 — the folder tree is always fetched for one project and one module
// (the workbench's module rail), and advancedResults now folds projectId into
// every list query, so this is the shape those reads run on.
FolderSchema.index({ projectId: 1, moduleId: 1 });

FolderSchema.pre('save', async function (next) {
    if (!this.isNew) {
        // If not a new document, move to the next middleware
        return next();
    }

    try {
        // WP-020c: atomic counter (was a read-then-write race, see
        // backend/shared/service-core/sequence.js for why).
        this.id = await getNextSequence(this.constructor.db, 'folder');
        return next();
    } catch (error) {
        return next(error);
    }
});
module.exports = mongoose.model('Folder', FolderSchema);