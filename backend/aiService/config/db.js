const mongoose = require('mongoose');

// WP-050 -- aiService's OWN database (srckube-ai, see docker-compose.yml's
// aiservice block). Stores only AiInteraction (the cost/audit log,
// configurable retention — see models/AiInteraction.js) and
// AiProjectSettings (the per-project enable/disable flag). This service
// never connects to another service's database.
const connectDB = async () => {
  const conn = await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useFindAndModify: false,
    useUnifiedTopology: true
  });

  console.log(`MongoDB Connected: ${conn.connection.host}`.cyan.underline.bold);
};

module.exports = connectDB;
