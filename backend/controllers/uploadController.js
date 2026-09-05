const cloudinary = require("../utils/cloudinary");

/**
 * Issue a short-lived signature for a DIRECT browser -> Cloudinary upload.
 *
 * The video file never touches this server (Lambda has a 6MB payload cap): the
 * browser uploads straight to Cloudinary using this signature, then sends us
 * only the resulting URL (stored as a checkout-question answer on the order).
 *
 * Signed (not unsigned-preset) so uploads are constrained to our folder and can
 * only be made by an authenticated customer. The signed params MUST exactly
 * match what the client posts alongside the file.
 */
exports.getVideoUploadSignature = async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "checkout_videos";
    // Constrain the upload to real video formats. `allowed_formats` is part of
    // the SIGNED params, so the client can't widen it — Cloudinary rejects
    // anything that isn't one of these formats (blocks storing HTML/JS/SVG/etc.
    // on our CDN even if the endpoint path is swapped).
    const allowedFormats = "mp4,webm,mov,m4v,ogv,3gp,avi,mkv";
    const signature = cloudinary.utils.api_sign_request(
      { allowed_formats: allowedFormats, folder, timestamp },
      process.env.CLOUD_API_SECRET
    );

    return res.status(200).json({
      cloudName: process.env.CLOUD_NAME,
      apiKey: process.env.CLOUD_API_KEY,
      timestamp,
      folder,
      allowedFormats,
      signature,
      // Where the browser posts the file (resource_type is part of the path,
      // not the signature).
      uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUD_NAME}/video/upload`,
    });
  } catch (err) {
    console.error("getVideoUploadSignature error:", err);
    return res.status(500).json({ message: "Could not create an upload signature", statusCode: 500 });
  }
};
