# OSANI + Genlook AI Virtual Try-On

This version keeps the existing OSANI storefront, Printrove order functions, MSG91 notifications and multilingual search, while replacing the broken try-on request with the current Genlook REST API flow.

## Files

- `index.html` — complete storefront, including the AI Try-On modal and browser-side image compression.
- `index.js` — complete existing Firebase Functions file, with the corrected `generateTryOnImage` callable.
- `tryonClient.js` — server-side Genlook REST integration.
- `package.json` — Firebase Functions dependencies.
- `SETUP.md` — these instructions.

## 1. Install dependencies

From the Firebase Functions directory:

```bash
npm install
```

The Genlook integration in `tryonClient.js` uses the REST API directly, so it does not depend on the Genlook SDK at runtime. `@genlook/api` remains listed because it is the official SDK and may be useful for future Genlook features.

## 2. Configure the Genlook API key

Create an API key in your Genlook account, then run:

```bash
firebase functions:secrets:set GENLOOK_API_KEY
```

Paste the real `gk_...` key when prompted.

Never put this key in `index.html`.

## 3. Verify the Genlook account has credits

Each successful try-on consumes one Genlook credit. If the account is out of credits, Genlook returns a 402 error such as `INSUFFICIENT_CREDITS`.

## 4. Product image requirement

For every product that can be tried on:

```text
products/{productId}.img
```

must contain a direct, publicly reachable HTTPS image URL, for example:

```text
https://cdn.example.com/products/trench-coat.jpg
```

Do NOT use a product-page URL such as:

```text
https://demo.genlook.app/products/stitch-trim-trench-coat
```

Genlook needs the actual product image URL so its servers can download the garment image.

## 5. Deploy Cloud Functions

From the Firebase project root:

```bash
firebase deploy --only functions
```

## 6. Deploy the website

Deploy the updated `index.html` using your existing Firebase Hosting workflow.

## 7. User flow

1. Customer opens a product.
2. Customer clicks `TRY IT ON WITH AI`.
3. Customer uploads a photo.
4. Browser compresses the photo to reduce callable request size.
5. Firebase sends the photo to Genlook securely.
6. Genlook receives the customer image and OSANI product image.
7. Genlook creates an asynchronous generation.
8. Firebase polls every 2 seconds until `COMPLETED` or `FAILED`.
9. OSANI displays the generated on-body image.

## 8. If the error is still shown

Open Firebase Functions logs:

```bash
firebase functions:log
```

The corrected backend now returns the actual Genlook error code/message instead of hiding it behind a generic `internal` message.

Common Genlook failure causes include:

- `INSUFFICIENT_CREDITS` — add Genlook credits.
- `PRODUCT_IMAGE_FETCH_FAILED` — the Firestore `product.img` URL cannot be fetched by Genlook.
- customer image rejected during preprocessing.
- invalid product image URL.
- generation pipeline failure.

## Important

This is AI photo-based virtual try-on. It is not continuous camera AR. Genlook also announced a separate Live Try-On beta in September 2026; that is a different integration from this photo-based API flow.
