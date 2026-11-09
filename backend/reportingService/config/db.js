const mongoose = require('mongoose');

// WP-040 — reportingService's OWN database (srckube-reporting, see
// docker-compose.yml's reportingservice block). This is the only Mongo
// connection this service ever opens: every other service's data is read
// over HTTP (see services/*.js), never via a direct Mongo connection to
// another service's database — that is the read-only guarantee this WP is
// built around. Materialized report documents (models/ReportCache.js) are
// the only thing ever written here.
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
