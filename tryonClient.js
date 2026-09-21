/**
 * tryonClient.js
 * OSANI -> Genlook Virtual Try-On REST client.
 *
 * Server-side only. The Genlook API key must never be exposed to the browser.
 *
 * Current Genlook flow:
 *   1) POST /tryon/v1/images/upload -> imageId
 *   2) POST /tryon/v1/try-on -> generationId
 *   3) GET  /tryon/v1/generations/:id until COMPLETED/FAILED
 *
 * NOTE: this uses axios + the "form-data" package instead of the
 * platform's built-in fetch/FormData/Blob. Cloud Functions' Node runtime
 * does expose fetch/FormData globally, but that undici-based
 * implementation has known edge cases generating multipart bodies that
 * some servers reject in ways that surface only as an opaque crash (the
 * Firebase callable client then just shows "internal" with no detail).
 * axios + form-data is the same battle-tested combo already used by
 * printroveClient.js and notifyClient.js, so this keeps behavior
 * consistent and errors properly surfaced.
 */

const axios = require("axios");
const FormData = require("form-data");

const BASE_URL = "https://api.genlook.app/tryon/v1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes an axios error (or any thrown error) into a plain Error with
 * .code / .status / .details / .requestId, mirroring what the old
 * fetch-based readResponse() attached — so index.js's error handling
 * doesn't need to change.
 */
function normalizeAxiosError(err, fallbackMessage) {
  if (!err.response) {
    // Network-level failure (DNS, timeout, connection reset, etc.) — no
    // response body to read.
    const error = new Error(err.message || fallbackMessage);
    error.code = err.code || "NETWORK_ERROR";
    return error;
  }

  const data = err.response.data || {};
  const message =
    (typeof data === "string" ? data : data.message) ||
    fallbackMessage ||
    `Genlook API returned HTTP ${err.response.status}`;

  const error = new Error(message);
  error.code = data.code || `HTTP_${err.response.status}`;
  error.status = data.status || err.response.status;
  error.details = data.details || (typeof data === "object" ? data : null);
  error.requestId = data.requestId || null;
  return error;
}

async function uploadCustomerPhoto(apiKey, photoBuffer, mimeType) {
  const safeMime = mimeType || "image/jpeg";
  const extension =
    safeMime === "image/png"
      ? "png"
      : safeMime === "image/webp"
        ? "webp"
        : safeMime === "image/heic"
          ? "heic"
          : "jpg";

  const form = new FormData();
  form.append("file", photoBuffer, {
    filename: `osani-customer.${extension}`,
    contentType: safeMime,
  });
  // Keep the original framing. Genlook's documentation recommends the
  // upload endpoint when you want control over cropping.
  form.append("crop", "false");

  try {
    const res = await axios.post(`${BASE_URL}/images/upload`, form, {
      headers: { "x-api-key": apiKey, ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res.data;
  } catch (err) {
    throw normalizeAxiosError(err, "Genlook photo upload failed.");
  }
}

async function createTryOn(apiKey, {
  imageId,
  productImageUrl,
  productTitle,
  productDescription,
  productId,
}) {
  if (!imageId) throw new Error("Genlook did not return a customer imageId.");
  if (!productImageUrl) throw new Error("OSANI product image URL is missing.");

  // Genlook requires an externally reachable HTTPS product image.
  if (!/^https:\/\//i.test(productImageUrl)) {
    const error = new Error(
      "The OSANI product image must be a public HTTPS URL that Genlook can reach."
    );
    error.code = "INVALID_PRODUCT_IMAGE_URL";
    throw error;
  }

  const payload = {
    products: [
      {
        externalId: String(productId || `osani-${Date.now()}`),
        title: productTitle || "OSANI Fashion Product",
        description:
          productDescription ||
          `Fashion product from OSANI. ${productTitle || ""}`.trim(),
        images: [
          {
            source: {
              url: productImageUrl,
            },
          },
        ],
      },
    ],
    person: {
      image: {
        source: {
          id: imageId,
        },
      },
    },
    output: {
      watermark: true,
      aiLabel: true,
      keepForDays: 1,
    },
  };

  try {
    const res = await axios.post(`${BASE_URL}/try-on`, payload, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    });
    return res.data;
  } catch (err) {
    throw normalizeAxiosError(err, "Genlook try-on request failed.");
  }
}

async function waitForGeneration(apiKey, generationId) {
  // Genlook documents polling every 2 seconds. 85 attempts gives us a
  // ~170s ceiling while the Firebase callable has a 180s limit.
  for (let attempt = 0; attempt < 85; attempt += 1) {
    let data;
    try {
      const res = await axios.get(
        `${BASE_URL}/generations/${encodeURIComponent(generationId)}`,
        { headers: { "x-api-key": apiKey } }
      );
      data = res.data;
    } catch (err) {
      throw normalizeAxiosError(err, "Genlook generation status check failed.");
    }

    const status = String(data.status || "").toUpperCase();

    console.log(
      `Genlook generation ${generationId}: ${status} (${attempt + 1}/85)`
    );

    if (status === "COMPLETED") {
      if (!data.resultImageUrl) {
        const error = new Error(
          "Genlook completed the generation but returned no result image URL."
        );
        error.code = "RESULT_IMAGE_MISSING";
        throw error;
      }

      return data;
    }

    if (status === "FAILED") {
      const error = new Error(
        data.errorMessage || "Genlook virtual try-on generation failed."
      );
      error.code = data.errorCode || "GENERATION_FAILED";
      error.status = 422;
      throw error;
    }

    await sleep(2000);
  }

  const timeout = new Error(
    "Genlook did not finish the try-on within the allowed time. Please try again."
  );
  timeout.code = "GENLOOK_TIMEOUT";
  throw timeout;
}

async function generateTryOn(apiKey, {
  userPhotoBase64,
  userPhotoMimeType = "image/jpeg",
  productImageUrl,
  productTitle,
  productDescription,
  productId,
}) {
  if (!apiKey) {
    const error = new Error("GENLOOK_API_KEY is not configured.");
    error.code = "GENLOOK_API_KEY_MISSING";
    throw error;
  }

  if (!userPhotoBase64) {
    throw new Error("Customer photo is required.");
  }

  if (!productImageUrl) {
    throw new Error("Product image URL is required.");
  }

  const photoBuffer = Buffer.from(userPhotoBase64, "base64");

  // Genlook accepts customer photos up to 10 MB. Keep a server-side guard too.
  if (photoBuffer.length > 10 * 1024 * 1024) {
    const error = new Error(
      "The customer photo is larger than Genlook's 10 MB limit."
    );
    error.code = "CUSTOMER_IMAGE_TOO_LARGE";
    throw error;
  }

  console.log("OSANI: uploading customer photo to Genlook...");

  const upload = await uploadCustomerPhoto(
    apiKey,
    photoBuffer,
    userPhotoMimeType
  );

  if (!upload.imageId) {
    throw new Error("Genlook upload succeeded but returned no imageId.");
  }

  console.log(`OSANI: Genlook customer imageId=${upload.imageId}`);

  console.log("OSANI: creating Genlook try-on generation...");

  const generation = await createTryOn(apiKey, {
    imageId: upload.imageId,
    productImageUrl,
    productTitle,
    productDescription,
    productId,
  });

  if (!generation.generationId) {
    throw new Error("Genlook did not return a generationId.");
  }

  console.log(
    `OSANI: Genlook generationId=${generation.generationId}`
  );

  const result = await waitForGeneration(
    apiKey,
    generation.generationId
  );

  return {
    success: true,
    resultImageUrl: result.resultImageUrl,
    generationId: generation.generationId,
    imageId: upload.imageId,
  };
}

module.exports = { generateTryOn };
