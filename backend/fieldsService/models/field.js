const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

const FieldSchema = new mongoose.Schema({
    id: {
        type: Number,
        unique: true,
    },
    fieldName: {
        type: String,
        required: [true, 'Please add a Field name']
    },
    displayName: {
        type: String,
        required: [true, 'Please add a Display name']
    },
    fieldType:{
        type: String,
        enum:['TextArea','Text','Date','DropDown','Editor','UserDropDown'],
        required: [true, 'Please add a Display name']
    },
    defaultValue:{
        type: [String],
    },
    moduleId:{
        type: Number,
        required: [true, 'Module Id is mandatory']
    },
    // WP-120 — index every tenant filter. This field was already required and
    // already enforced by the controllers (fieldsService was scoped in WP-021's
    // wave), it simply had no index, so every scoped list read was a collection
    // scan filtered after the fact.
    projectId:{
        type: Number,
        required: [true, 'Project Id is mandatory'],
        index: true
    },
    isDisplayed:{
        type: Boolean,
        required: [true, 'is Displayed is Mandatory']
    },
    isDefault:{
        type: Boolean,
        required: [true, 'is Default is Mandatory']
    },
    isEnabled:{
        type: Boolean,
        required: [true, 'is Enabled is Mandatory']
    },
    isMandatory:{
        type: Boolean,
        required: [true, 'Please fill is mandatory field to save']
    },
    createdBy:{ 
         type: String
    },
    updatedBy: 
        { type: String }
    
},
    {
        timestamps: true
    }
)
FieldSchema.pre('save', async function (next) {
    if (!this.isNew) {
        // If not a new document, move to the next middleware
        return next();
    }

    try {
        // WP-020c: atomic counter (was a read-then-write race, see
        // backend/shared/service-core/sequence.js for why).
        this.id = await getNextSequence(this.constructor.db, 'field');
        return next();
    } catch (error) {
        return next(error);
    }
});
FieldSchema.virtual('concatenatedField').get(function() {
    return 'Prefix_' + this.id;
  });


// WP-120 — a field set is always read for one project and one module, which is
// what the scoped list route queries.
FieldSchema.index({ projectId: 1, moduleId: 1 });

module.exports = mongoose.model('Field', FieldSchema);