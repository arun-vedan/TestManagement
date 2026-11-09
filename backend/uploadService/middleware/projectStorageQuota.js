const mongoose = require("mongoose");
const { maxProjectBytes, maxFileBytes } = require("../utils/upload");

// WP-135 (partial) — the per-tenant storage ceiling.
//
// WHY THIS IS A SEPARATE MIDDLEWARE AND NOT A multer OPTION. multer has
// `limits.fileSize`, which bounds ONE file, and nothing that bounds a tenant's
// accumulated total. GridFsStorage also streams each upload directly into
// GridFS as it arrives, so by the time a handler could measure the result the
// bytes are already stored. Rejecting afterwards would mean deleting what was
// just written, and a failed delete would leave the quota permanently
// overspent with no record of why.
//
// So this runs BEFORE multer and refuses the request when the project is
// already at or over its ceiling.
//
// THE BOUND THIS GIVES, STATED PRECISELY: a project can end at most
// (quota - 1 byte) + maxFilesPerRequest * maxFileBytes, because the final
// accepted request is measured before its own payload is counted. It is not a
// hard ceiling and is not presented as one. With the default 2 GiB quota and
// 25 MiB per file that is an overshoot of at most ~250 MiB, which is the right
// trade for a check that costs one indexed aggregate and cannot corrupt
// anything. A hard ceiling needs per-chunk accounting inside the storage
// engine, which is a much larger change for a bound nobody is relying on to
// the byte.
//
// The aggregate is served by the metadata.projectId index WP-112 added to
// filesBucket.files (see routes/attachment.js), so this is an indexed lookup,
// not a collection scan.

function filesCollection() {
  // The GridFS files collection is driver-owned -- this service has no
  // Mongoose model for it -- so it is reached through the native connection,
  // exactly as routes/attachment.js does.
  return mongoose.connection.db.collection("filesBucket.files");
}

async function projectUsageBytes(projectId) {
  const result = await filesCollection()
    .aggregate([
      { $match: { "metadata.projectId": projectId } },
      { $group: { _id: null, bytes: { $sum: "$length" }, files: { $sum: 1 } } }
    ])
    .toArray();
  if (result.length === 0) return { bytes: 0, files: 0 };
  return { bytes: result[0].bytes || 0, files: result[0].files || 0 };
}

function requireProjectStorageQuota() {
  return async function projectStorageQuota(req, res, next) {
    // Mounted after requireProjectScope(), so a missing scope here is a
    // wiring mistake rather than an anonymous caller. Fail closed: skipping
    // the check because the scope is absent would make the quota optional.
    const projectId = req.projectScope && req.projectScope.projectId;
    if (projectId === undefined) {
      return res.status(500).json({
        success: false,
        error: "uploadService: storage quota check ran without a verified project scope"
      });
    }

    const quota = maxProjectBytes();
    let usage;
    try {
      usage = await projectUsageBytes(projectId);
    } catch (err) {
      // FAIL CLOSED, deliberately, and this is the opposite of the posture
      // aiService's rate limiter takes. That one fails OPEN on a Redis blip
      // because a cost cap must not take the product down. This is a storage
      // ceiling backed by the SAME database the upload is about to be written
      // to: if the aggregate cannot run, the write is very unlikely to
      // succeed either, and letting uploads through unmetered during a
      // database problem is how a disk fills.
      return res.status(503).json({
        success: false,
        error: "Cannot verify the project's storage usage right now; upload refused"
      });
    }

    if (usage.bytes >= quota) {
      const usedMiB = Math.round(usage.bytes / (1024 * 1024));
      const quotaMiB = Math.round(quota / (1024 * 1024));
      return res.status(413).json({
        success: false,
        error:
          `This project has used ${usedMiB} MiB of its ${quotaMiB} MiB attachment allowance ` +
          `(${usage.files} files). Delete some attachments before uploading more.`
      });
    }

    // Surfaced for the handler and for tests; also lets a future UI show
    // remaining allowance without a second round trip.
    req.projectStorage = {
      usedBytes: usage.bytes,
      files: usage.files,
      quotaBytes: quota,
      remainingBytes: quota - usage.bytes
    };
    return next();
  };
}

module.exports = { requireProjectStorageQuota, projectUsageBytes };
