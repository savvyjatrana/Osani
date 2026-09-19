/**
 * tryonClient.js
 * Genlook AI virtual try-on client.
 *
 * IMPORTANT: This module runs server-side only. Never expose GENLOOK_API_KEY
 * in browser/client code.
 *
 * Flow:
 *   1) Upload shopper photo to Genlook -> imageId
 *   2) Send the OSANI product image + shopper imageId -> generationId
 *   3) Wait for the photorealistic on-body result -> resultImageUrl
 */

const { Genlook } = require("@genlook/api");

async function generateTryOn(apiKey, {
  userPhotoBase64,
  userPhotoMimeType = "image/jpeg",
  productImageUrl,
  productTitle,
  productId,
}) {
  if (!apiKey) throw new Error("GENLOOK_API_KEY is not configured.");
  if (!userPhotoBase64) throw new Error("Customer photo is required.");
  if (!productImageUrl) throw new Error("Product image URL is required.");

  const client = new Genlook({
    apiKey,
    timeoutMs: 60000,
    maxRetries: 2,
  });

  const photoBuffer = Buffer.from(userPhotoBase64, "base64");

  // Upload the shopper photo once. The returned imageId can be reused for
  // multiple products during the same session if you later add that feature.
  const { imageId } = await client.images.upload(photoBuffer, {
    mimeType: userPhotoMimeType || "image/jpeg",
  });

  const generation = await client.tryOn.create({
    product: {
      externalId: String(productId || productTitle || "osani-product"),
      title: productTitle || "OSANI fashion product",
      description: `Fashion product from OSANI. ${productTitle || ""}`.trim(),
      images: [{ url: productImageUrl }],
    },
    customer: { id: imageId },
  });

  const result = await client.generations.waitFor(generation.generationId);

  if (!result?.resultImageUrl) {
    throw new Error("Genlook completed the try-on but did not return an image URL.");
  }

  return {
    resultImageUrl: result.resultImageUrl,
    generationId: generation.generationId,
    imageId,
  };
}

module.exports = { generateTryOn };
