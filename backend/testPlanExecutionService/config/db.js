const mongoose = require('mongoose');

// Two connections, two untouched databases (srckube-testplan, srckube-testexecution) —
// this consolidation merges the SERVICE boundary only, not the data. Normalizing
// the overlapping TestCases data between the two is deliberately deferred (see
// TB-08 in the strategy doc) so this migration carries zero data-loss risk.

const planConnection = mongoose.createConnection(process.env.MONGO_URI_TESTPLAN, {
  useNewUrlParser: true,
  useCreateIndex: true,
  useFindAndModify: false,
  useUnifiedTopology: true
});

const executionConnection = mongoose.createConnection(process.env.MONGO_URI_TESTEXECUTION, {
  useNewUrlParser: true,
  useCreateIndex: true,
  useFindAndModify: false,
  useUnifiedTopology: true
});

planConnection.on('connected', () => {
  console.log(`TestPlan MongoDB Connected: ${planConnection.host}`.cyan.underline.bold);
});
executionConnection.on('connected', () => {
  console.log(`TestExecution MongoDB Connected: ${executionConnection.host}`.cyan.underline.bold);
});

module.exports = { planConnection, executionConnection };
