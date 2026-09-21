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
 */

const BASE_URL = "https://api.genlook.app/tryon/v1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponse(response) {
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { message: text || "Unknown Genlook response" };
  }

  if (!response.ok) {
    const error = new Error(
      data.message || `Genlook API returned HTTP ${response.status}`
    );
    error.code = data.code || `HTTP_${response.status}`;
    error.status = data.status || response.status;
    error.details = data.details || null;
    error.requestId = data.requestId || null;
    throw error;
  }

  return data;
}

async function uploadCustomerPhoto(apiKey, photoBuffer, mimeType) {
  const form = new FormData();

  const safeMime = mimeType || "image/jpeg";
  const extension =
    safeMime === "image/png"
      ? "png"
      : safeMime === "image/webp"
        ? "webp"
        : safeMime === "image/heic"
          ? "heic"
          : "jpg";

  form.append(
    "file",
    new Blob([photoBuffer], { type: safeMime }),
    `osani-customer.${extension}`
  );

  // Keep the original framing. Genlook's documentation recommends the
  // upload endpoint when you want control over cropping.
  form.append("crop", "false");

  const response = await fetch(`${BASE_URL}/images/upload`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
  });

  return readResponse(response);
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

  const response = await fetch(`${BASE_URL}/try-on`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readResponse(response);
}

async function waitForGeneration(apiKey, generationId) {
  // Genlook documents polling every 2 seconds. 90 attempts gives us a
  // three-minute ceiling while the Firebase callable also has a 180s limit.
  for (let attempt = 0; attempt < 85; attempt += 1) {
    const response = await fetch(
      `${BASE_URL}/generations/${encodeURIComponent(generationId)}`,
      {
        method: "GET",
        headers: { "x-api-key": apiKey },
      }
    );

    const data = await readResponse(response);
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
    throw new Error("GENLOOK_API_KEY is not configured.");
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
