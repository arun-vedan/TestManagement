const path = require("path");
const multer = require("multer");
const { GridFsStorage } = require("multer-gridfs-storage");
const dotenv = require("dotenv");
dotenv.config({ path: './config/config.env' });

// WP-135 (partial) — abuse and cost controls on file upload.
//
// WHAT WAS THERE: `multer({ storage })`. No `limits`, no `fileFilter`. No
// per-file size cap, no type restriction, no per-tenant ceiling, anywhere.
// With self-serve signup live (WP-130) that is free, unlimited file hosting
// for anyone who can create an account, and a single request could exhaust
// the disk backing Mongo.
//
// WHAT IS DELIBERATELY NOT DECIDED HERE: the numbers. WP-135 depends on
// owner-provided caps, and the owner has not set them. So every limit below
// is an env var with a conservative default, and changing them is a config
// edit rather than a code change. The MECHANISM is the work; the figures are
// a line in .env.
//
// HONEST LIMITATION OF THE TYPE CHECK. `file.mimetype` is supplied by the
// client, so an allow-list over it stops an honest mistake and a casual
// abuser, not a determined one -- anybody can label an executable
// `image/png`. The extension is checked too, which raises the bar slightly,
// but neither is content inspection. Real sniffing means buffering the head
// of each stream and matching magic bytes, which is a different piece of work
// with its own failure modes. What this DOES achieve is that the stored
// `contentType` is constrained to a known set, and the download route echoes
// that stored value back as the response Content-Type -- so the allow-list
// bounds what this service will ever claim a file is.

const MiB = 1024 * 1024;

// 25 MiB. Chosen to fit the attachments this product actually takes --
// screenshots, logs, a JUnit XML, a PDF, a short screen recording -- and to be
// obviously too small for someone using the product as a file host.
const DEFAULT_MAX_FILE_BYTES = 25 * MiB;

// 2 GiB per project. Generous for genuine use, bounded for abuse.
const DEFAULT_MAX_PROJECT_BYTES = 2048 * MiB;

// Ten files per multipart request, so /upload/files cannot be used to send
// ten thousand small files in one call and sidestep the per-file cap.
const DEFAULT_MAX_FILES_PER_REQUEST = 10;

// The types a test-management tool genuinely needs. Notable exclusions, each
// deliberate:
//   image/svg+xml, text/html  -- can carry script. The download route sets
//     Content-Disposition: attachment, which stops them rendering inline
//     today, but that is one header away from being a stored-XSS vector and
//     an allow-list should not depend on a header elsewhere staying correct.
//   application/x-msdownload, application/x-sh and friends -- executables.
//   office macro formats -- the same argument.
// XML is included because CI result ingestion (WP-033) is a first-class use:
// a JUnit report is the single most likely attachment on a test run.
const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/zip",
  "video/mp4",
  "video/webm"
];

// Extensions that pair with the types above. Checked in addition to the
// mimetype so a file called `payload.exe` is refused even when it is labelled
// image/png.
const DEFAULT_ALLOWED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".txt", ".log", ".csv", ".md",
  ".json", ".xml", ".zip", ".mp4", ".webm"
];

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();

  // DIGITS ONLY, checked before parsing. parseInt is too forgiving to use on
  // operator input here: parseInt('1e9', 10) is 1, and parseInt('25MB', 10)
  // is 25. Either would silently install an absurdly SMALL cap -- '1e9',
  // written by someone meaning a billion bytes, becomes a one-byte limit that
  // rejects every upload, and the service would look broken rather than
  // misconfigured. A value this function cannot read exactly falls back to
  // the documented default. (Found by this module's own test, which asserted
  // the fallback for '1e9' and got 1.)
  if (!/^[0-9]+$/.test(text)) return fallback;

  const parsed = parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const items = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function maxFileBytes() {
  return intFromEnv("UPLOAD_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
}
function maxProjectBytes() {
  return intFromEnv("UPLOAD_MAX_PROJECT_BYTES", DEFAULT_MAX_PROJECT_BYTES);
}
function maxFilesPerRequest() {
  return intFromEnv("UPLOAD_MAX_FILES_PER_REQUEST", DEFAULT_MAX_FILES_PER_REQUEST);
}
function allowedMimeTypes() {
  return listFromEnv("UPLOAD_ALLOWED_MIME_TYPES", DEFAULT_ALLOWED_MIME_TYPES.map((t) => t.toLowerCase()));
}
function allowedExtensions() {
  return listFromEnv("UPLOAD_ALLOWED_EXTENSIONS", DEFAULT_ALLOWED_EXTENSIONS);
}

// Shaped like a multer error so routes can translate every rejection the same
// way, rather than having a bespoke branch for type failures.
function rejectFile(code, message) {
  const err = new multer.MulterError(code);
  err.message = message;
  return err;
}

function fileFilter(req, file, cb) {
  const mime = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(String(file.originalname || "")).toLowerCase();

  if (!allowedMimeTypes().includes(mime)) {
    return cb(
      rejectFile(
        "LIMIT_UNEXPECTED_FILE",
        `File type '${file.mimetype || "unknown"}' is not accepted. Allowed types: ${allowedMimeTypes().join(", ")}`
      )
    );
  }
  if (ext && !allowedExtensions().includes(ext)) {
    return cb(
      rejectFile(
        "LIMIT_UNEXPECTED_FILE",
        `File extension '${ext}' is not accepted. Allowed extensions: ${allowedExtensions().join(", ")}`
      )
    );
  }
  return cb(null, true);
}

// RFC 6266 Content-Disposition for a user-supplied filename.
//
// The download route interpolated the stored filename straight into the
// header: `attachment; filename=${file.filename}`. Filenames come from the
// uploader, so a name containing a quote, a semicolon or a comma breaks the
// header's own grammar -- at best the browser saves the file under a mangled
// name, at worst a parser downstream reads the trailing fragment as another
// header parameter. Node rejects CR and LF in a header value, so outright
// response splitting was never possible; this closes the rest.
//
// Emits BOTH forms, which is what RFC 6266 section 4.3 prescribes and what
// browsers actually need:
//   filename=   a quoted ASCII fallback, for clients that ignore filename*
//   filename*=  RFC 5987 percent-encoded UTF-8, so a name like
//               "réspønse-日本語.png" survives
// A client that understands filename* prefers it; the fallback keeps the rest
// working instead of degrading to a generic name.
function contentDisposition(filename) {
  const name = String(filename === undefined || filename === null ? "" : filename)
    // Strip any path component: a stored name of "../../etc/passwd" must not
    // reach the client as a directory traversal hint, and the basename is the
    // only part a download needs.
    .replace(/^.*[\\/]/, "")
    .trim() || "download";

  // The quoted fallback keeps printable ASCII only, with backslash and quote
  // escaped per the header grammar; anything else becomes an underscore so the
  // fallback is always a well-formed token.
  const ascii = name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");

  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function upload() {
  const mongodbUrl = process.env.MONGO_URI;
  const storage = new GridFsStorage({
    url: mongodbUrl,
    file: (req, file) => {
      return new Promise((resolve, reject) => {
        // WP-112 — stamp the tenant onto the GridFS file's metadata.
        //
        // This service has no Mongoose model to put a projectId field on; its
        // storage IS the GridFS bucket, so `metadata` is where tenancy has to
        // live, and it is what routes/attachment.js filters every read on.
        //
        // Taken from req.projectScope, which requireProjectScope() sets, so
        // the upload routes must mount that middleware BEFORE multer runs --
        // see routes/attachment.js. If it is missing we REJECT rather than
        // storing an unscoped file: an attachment with no projectId is
        // invisible to every scoped route afterwards, so writing one would
        // silently lose the user's file rather than fail their request.
        if (!req.projectScope || req.projectScope.projectId === undefined) {
          return reject(
            new Error(
              'uploadService: no verified project scope on the request; refusing to store an unscoped file'
            )
          );
        }
        resolve({
          filename: file.originalname,
          bucketName: "filesBucket",
          metadata: { projectId: req.projectScope.projectId }
        });
      });
    },
  });

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: maxFileBytes(),
      files: maxFilesPerRequest()
    }
  });
}

// Translates multer's rejections into the right status with an actionable
// message. Without this they reach the shared errorHandler and surface as a
// bare 500, which tells a user nothing about a file being too large -- and
// WP-135's acceptance asks specifically for actionable messages.
function uploadErrorHandler(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) return next(err);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      error: `File is larger than the ${Math.round(maxFileBytes() / MiB)} MiB limit`
    });
  }
  if (err.code === "LIMIT_FILE_COUNT") {
    return res.status(413).json({
      success: false,
      error: `Too many files in one request; the limit is ${maxFilesPerRequest()}`
    });
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    // Also multer's code for an unexpected field name, but fileFilter above
    // reuses it with its own message, which is the more useful one.
    return res.status(415).json({ success: false, error: err.message });
  }
  return res.status(400).json({ success: false, error: err.message });
}

module.exports = {
  upload,
  contentDisposition,
  uploadErrorHandler,
  maxFileBytes,
  maxProjectBytes,
  maxFilesPerRequest,
  allowedMimeTypes,
  allowedExtensions
};
