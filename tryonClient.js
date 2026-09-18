/**
 * tryonClient.js
 * Wraps Google's Gemini image-generation model (gemini-2.5-flash-image,
 * aka "nano banana") to power the AI try-on feature: given a customer's
 * photo and a product photo, ask Gemini to generate an image of the
 * customer wearing/using the product.
 *
 * Auth model: a single Gemini API key (from Google AI Studio —
 * https://aistudio.google.com/apikey), sent as a header on every request.
 * No token exchange, unlike Printrove.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/image-generation
 */

const axios = require("axios");

const MODEL = "gemini-2.5-flash-image";
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Generates a try-on image from a customer photo + a product photo.
 *
 * `userPhotoBase64` / `productImageBase64` must be raw base64 (no
 * "data:image/...;base64," prefix — strip that on the client/caller side).
 *
 * Returns { imageBase64, mimeType }.
 * Throws if Gemini errors, or if it responds without an image (e.g. it
 * refused the request on safety grounds and returned text instead).
 */
async function generateTryOn(apiKey, {
  userPhotoBase64,
  userPhotoMimeType = "image/jpeg",
  productImageBase64,
  productImageMimeType = "image/jpeg",
  productTitle,
}) {
  const prompt = [
    "You are a virtual try-on tool for an online store.",
    "The first attached image is a photo of a customer.",
    `The second attached image is a product${productTitle ? ` called "${productTitle}"` : ""}.`,
    "Generate a single realistic photo of the customer wearing or using this product.",
    "Keep the customer's face, body, pose, skin tone, and background as close to the original photo as possible.",
    "Only change what's needed to naturally place the product on them.",
    "Do not add any text, watermark, or logo to the image.",
  ].join(" ");

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: userPhotoMimeType, data: userPhotoBase64 } },
          { inline_data: { mime_type: productImageMimeType, data: productImageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
    },
  };

  const res = await axios.post(BASE_URL, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    timeout: 55000,
  });

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData || p.inline_data);
  const inline = imagePart?.inlineData || imagePart?.inline_data;

  if (!inline?.data) {
    // Gemini can decline (safety filters, unclear photo, etc.) and return
    // text instead of an image — surface that text as the error so the
    // customer sees something meaningful rather than a generic failure.
    const textPart = parts.find((p) => p.text);
    throw new Error(textPart?.text || "Gemini did not return an image for this request.");
  }

  return {
    imageBase64: inline.data,
    mimeType: inline.mimeType || inline.mime_type || "image/png",
  };
}

module.exports = { generateTryOn };
