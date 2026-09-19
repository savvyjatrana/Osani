# OSANI + Genlook AI Try-On

These files switch OSANI's product try-on from the previous Gemini image flow to Genlook's Virtual Try-On API.

## 1. Install dependencies

From the Firebase Functions directory:

```bash
npm install
```

## 2. Add the Genlook secret

Create a Genlook API key in the Genlook developer dashboard, then set it as a Firebase Functions secret:

```bash
firebase functions:secrets:set GENLOOK_API_KEY
```

The key stays server-side. Do not put it in `index.html`.

## 3. Deploy Functions

```bash
firebase deploy --only functions
```

## 4. Deploy the website

Replace your existing `index.html` with the updated file and deploy it using your existing hosting workflow.

## Important

The product image stored in Firestore as `products/{productId}.img` must be a publicly accessible HTTPS image URL. Genlook uses that URL directly for the garment image.

The experience is AI photo try-on: the shopper uploads one photo and receives an on-body result in seconds. It is not continuous live AR/video tracking.
