const express = require('express');
const router = express.Router({ mergeParams: true });

const { default: mongoose } = require("mongoose");
const { upload, uploadErrorHandler, contentDisposition } = require("../utils/upload");
const { requireProjectStorageQuota } = require("../middleware/projectStorageQuota");
const archiver = require("archiver");
const { Transform } = require("stream");
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()

// WP-112 — every route below is scoped: keycloak.protect() then
// requireProjectScope() then authorize(action), the same order as every other
// migrated service.
//
// THE LEAK THIS CLOSES. GET /download/files and /download/files2 called
// `bucket.find()` with NO FILTER AT ALL -- they zipped up and returned EVERY
// file in the bucket, across every tenant, to any authenticated caller. That
// is a worse class of exposure than an over-broad list endpoint: the response
// body is the file contents themselves, so there is nothing downstream that
// could have limited the damage.
//
// Tenancy lives in the GridFS file's `metadata.projectId` (stamped by
// utils/upload.js) because this service has no Mongoose model -- its storage
// IS the bucket.
//
// GridFSBucket's delete()/rename() take only an _id and accept no filter, so
// those two routes verify ownership with a scoped find() FIRST and then act.
// Without that an id from another project would have been deleted or renamed
// quite happily.
function scopedFilter(req, extra) {
  return Object.assign({ 'metadata.projectId': req.projectScope.projectId }, extra || {});
}
let bucket;
(() => {
  mongoose.connection.on("connected", () => {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "filesBucket",
    });
    if (bucket) {
      console.log("Bucket is ready to use");
    }

    // WP-120 — index the tenant filter.
    //
    // Every scoped read here filters on `metadata.projectId`, but
    // filesBucket.files is created and owned by the GridFS driver, not by a
    // Mongoose model, so none of the schema-level indexes the other services
    // declare apply to it. Without this, explain() on the scoped query showed
    // COLLSCAN while all fourteen other tenant filters showed IXSCAN.
    //
    // Created at startup rather than as a one-off DB command so a fresh
    // deployment gets it too. createIndex is idempotent, and it is
    // deliberately NOT awaited into the boot path: a failure here must not
    // stop the service from serving uploads, so it logs and continues.
    mongoose.connection.db
      .collection("filesBucket.files")
      .createIndex({ "metadata.projectId": 1 }, { background: true })
      .then(() => console.log("filesBucket.files metadata.projectId index ensured"))
      .catch((err) =>
        console.error("could not ensure filesBucket.files index:", err.message)
      );
  });
})();

// WP-135 -- requireProjectStorageQuota() runs BEFORE multer, because
// GridFsStorage streams each upload straight into GridFS: once multer has run
// the bytes are already stored, and rejecting then would mean deleting what
// was just written. uploadErrorHandler sits AFTER the handler so multer's own
// rejections (too large, too many, disallowed type) become 413/415 with an
// actionable message instead of reaching the shared errorHandler as a bare
// 500.
router.post(
  "/upload/file",
  keycloak.protect(),
  requireProjectScope(),
  authorize('write'),
  requireProjectStorageQuota(),
  upload().single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: "No file was supplied" });
      }
      res.status(201).json({ fileID:req.file.id });
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to upload file`, error },
      });
    }
  },
  uploadErrorHandler
);
  
  // Upload multiple files
router.post(
  "/upload/files",
  keycloak.protect(),
  requireProjectScope(),
  authorize('write'),
  requireProjectStorageQuota(),
  upload().array("files"),
  async (req, res) => {
    try {
      res.status(201).json({ text: "Files uploaded successfully !", count: (req.files || []).length });
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to upload files`, error },
      });
    }
  },
  uploadErrorHandler
);
  
  // Download a file by id
  router.route("/download/file/:fileId").get(keycloak.protect(), requireProjectScope(), authorize('read'), async (req, res) => {
    try {
      const { fileId } = req.params;
      console.log(fileId)
      // Check if file exists
    
      // WP-112: scoped -- a file belonging to another project reads as
      // "not found" rather than being streamed out.
      const file = await bucket
        .find(scopedFilter(req, { _id: new mongoose.Types.ObjectId(fileId) }))
        .toArray();
      if (file.length === 0) {
        return res.status(404).json({ error: { text: "File not found" } });
      }
  
      // set the headers
      res.set("Content-Type", file[0].contentType);
      // RFC 6266, both forms -- the filename comes from the uploader.
      res.set("Content-Disposition", contentDisposition(file[0].filename));
  
      // create a stream to read from the bucket
      const downloadStream = bucket.openDownloadStream(
        new mongoose.Types.ObjectId(fileId)
      );
  
      // pipe the stream to the response
      downloadStream.pipe(res);
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to download file`, error },
      });
    }
  });
  
  // Download all files
  router.get("/download/files", keycloak.protect(), requireProjectScope(), authorize('read'), async (req, res) => {
    try {
      // WP-112: was bucket.find() -- every file in the system, every tenant.
      const files = await bucket.find(scopedFilter(req)).toArray();
      if (files.length === 0) {
        return res.status(404).json({ error: { text: "No files found" } });
      }
      res.set("Content-Type", "application/zip");
      res.set("Content-Disposition", contentDisposition("files.zip"));
      res.set("Access-Control-Allow-Origin", "*");
      const archive = archiver("zip", {
        zlib: { level: 9 },
      });
  
      archive.pipe(res);
  
      files.forEach((file) => {
        const downloadStream = bucket.openDownloadStream(
          new mongoose.Types.ObjectId(file._id)
        );
        archive.append(downloadStream, { name: file.filename });
      });
  
      archive.finalize();
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to download files`, error },
      });
    }
  });
  
  // Download all files
  router.get("/download/files2", keycloak.protect(), requireProjectScope(), authorize('read'), async (req, res) => {
    try {
      // WP-112: was bucket.find() -- same unfiltered leak as /download/files.
      const cursor = bucket.find(scopedFilter(req));
      const files = await cursor.toArray();
  
      const filesData = await Promise.all(
        files.map((file) => {
          return new Promise((resolve, _reject) => {
            bucket.openDownloadStream(file._id).pipe(
              (() => {
                const chunks = [];
                return new Transform({
                  // transform method will
                  transform(chunk, encoding, done) {
                    chunks.push(chunk);
                    done();
                  },
                  flush(done) {
                    const fbuf = Buffer.concat(chunks);
                    const fileBase64String = fbuf.toString("base64");
                    resolve(fileBase64String);
                    done();
  
                    // use the following instead if you want to return also the file metadata (like its name and other information)
                    /*const fileData = {
                      ...file, // file metadata
                      fileBase64String: fbuf.toString("base64"),
                    };
                    resolve(fileData);
                    done();*/
                  },
                });
              })()
            );
          });
        })
      );
      res.status(200).json(filesData);
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to retrieve files`, error },
      });
    }
  });
  
  // Rename a file
  router.put("/rename/file/:fileId", keycloak.protect(), requireProjectScope(), authorize('write'), async (req, res) => {
    try {
      const { fileId } = req.params;
      const { filename } = req.body;
      // WP-112: bucket.rename() takes no filter, so ownership is checked
      // first -- otherwise any valid id from another project could be renamed.
      const owned = await bucket
        .find(scopedFilter(req, { _id: new mongoose.Types.ObjectId(fileId) }))
        .toArray();
      if (owned.length === 0) {
        return res.status(404).json({ error: { text: "File not found" } });
      }
      await bucket.rename(new mongoose.Types.ObjectId(fileId), filename);
      res.status(200).json({ text: "File renamed successfully !" });
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to rename file`, error },
      });
    }
  });
  
  // Delete a file
  router.delete("/delete/file/:fileId", keycloak.protect(), requireProjectScope(), authorize('delete'), async (req, res) => {
    try {
      const { fileId } = req.params;
      // WP-112: bucket.delete() takes no filter -- ownership checked first.
      const owned = await bucket
        .find(scopedFilter(req, { _id: new mongoose.Types.ObjectId(fileId) }))
        .toArray();
      if (owned.length === 0) {
        return res.status(404).json({ error: { text: "File not found" } });
      }
      await bucket.delete(new mongoose.Types.ObjectId(fileId));
      res.status(200).json({ text: "File deleted successfully !" });
    } catch (error) {
      console.log(error);
      res.status(400).json({
        error: { text: `Unable to delete file`, error },
      });
    }
  });

  module.exports = router;