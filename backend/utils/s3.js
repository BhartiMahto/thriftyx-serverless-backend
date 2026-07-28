const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

/**
 * S3 storage for gallery and event images.
 *
 * Credentials come from the environment only — never commit them. Note there
 * are two bucket names in the existing data: `thriftyx-all-document` (this one,
 * reachable) and `thriftyx-all-documents` (403). See CHANGES.md.
 */

const REGION = process.env.AWS_REGION || "ap-south-1";
const BUCKET = process.env.S3_BUCKET;
const BASE_URL =
  process.env.S3_BASE_URL || (BUCKET ? `https://${BUCKET}.s3.${REGION}.amazonaws.com/` : null);

// Two credential sources:
//   - Local / non-AWS hosts: explicit AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.
//   - AWS Lambda: the function's IAM role (the SDK's default provider chain).
//     Lambda forbids setting AWS_* env vars, so keys are absent there by design.
// Either way we only need a bucket name to be "configured".
const hasExplicitKeys = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const isConfigured = Boolean(BUCKET);

if (!isConfigured) {
  console.warn("[s3] S3_BUCKET not set — S3 uploads are disabled.");
}

const client = isConfigured
  ? new S3Client({
      region: REGION,
      // Omitting credentials lets the SDK fall back to the Lambda role / instance profile.
      ...(hasExplicitKeys
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    })
  : null;

/**
 * Builds a key in the shape the existing objects already use:
 * `<4 random chars><timestamp>-<sanitised original name>`.
 */
const buildKey = (originalName = "file") => {
  const random = crypto.randomBytes(3).toString("base64url").slice(0, 4);
  const ext = path.extname(originalName);
  const stem = path
    .basename(originalName, ext)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 40) || "file";

  return `${random}${Date.now()}-${stem}${ext.toLowerCase()}`;
};

/** Uploads a buffer and returns its public URL. */
const uploadBuffer = async (buffer, { originalName, mimetype, prefix = "" } = {}) => {
  if (!isConfigured) throw new Error("S3 is not configured");

  const key = `${prefix}${buildKey(originalName)}`;

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || "application/octet-stream",
      // No ACL is set: the bucket serves objects publicly via bucket policy,
      // and buckets with "Block Public Access" reject object ACLs outright.
    })
  );

  return { key, url: `${BASE_URL}${encodeURI(key)}` };
};

/** Extracts the object key from a URL, or null if it isn't in our bucket. */
const keyFromUrl = (url) => {
  if (!url || !BASE_URL) return null;
  try {
    const parsed = new URL(url);
    const base = new URL(BASE_URL);
    if (parsed.host !== base.host) return null;
    return decodeURIComponent(parsed.pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
};

/**
 * Deletes the object behind a URL. Returns false when the URL belongs to
 * another host (e.g. the legacy Cloudinary images) rather than throwing, so a
 * mixed-storage gallery can still be cleaned up record by record.
 */
const deleteByUrl = async (url) => {
  if (!isConfigured) return false;

  const key = keyFromUrl(url);
  if (!key) return false;

  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return true;
};

/** Lists objects in the bucket (used to import files uploaded outside the app). */
const listObjects = async ({ prefix = "", maxKeys = 1000, continuationToken } = {}) => {
  if (!isConfigured) throw new Error("S3 is not configured");

  const out = await client.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken,
    })
  );

  return {
    objects: (out.Contents || []).map((o) => ({
      key: o.Key,
      size: o.Size,
      lastModified: o.LastModified,
      url: `${BASE_URL}${encodeURI(o.Key)}`,
    })),
    nextToken: out.NextContinuationToken || null,
    isTruncated: Boolean(out.IsTruncated),
  };
};

const objectExists = async (key) => {
  if (!isConfigured) return false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  client,
  isConfigured,
  BUCKET,
  BASE_URL,
  uploadBuffer,
  deleteByUrl,
  keyFromUrl,
  listObjects,
  objectExists,
};
