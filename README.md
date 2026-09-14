# Printrove ↔ Firebase Integration for Osani.com

Your `index.html` (storefront) and `admin.html` (dashboard) are now wired to
actually create and track real orders — previously checkout only showed a
fake "Order Placed" popup and never touched the database.

## Files

- `index.html`, `admin.html` — your two site files, edited in place
- `functions/printroveClient.js` — talks to `api.printrove.com`, handles auth token caching
- `functions/index.js` — Cloud Functions: push-on-create, manual retry, scheduled tracking sync
- `functions/package.json` — dependencies
- `firestore.rules` — security rules for the `products` and `orders` collections

## What changed on the site

**index.html**
- Checkout now writes a real order to the `orders` Firestore collection (structured address, sanitized phone, cart items, computed total) instead of just showing a fake success screen.
- The address field is now split into Address Line 1/2, City, State, Pincode, Country — Printrove's API needs these separately.
- Checkout blocks with a clear message if a cart item has no Printrove Variant ID yet.
- "📦 Orders" now opens a **Track My Order** box — customers enter their Order ID (shown on the confirmation screen) to see live status and tracking.

**admin.html**
- Product form has a new **Printrove Variant ID** field; products missing one show a "⚠ not linked" warning in the inventory table.
- New **Orders & Printrove Fulfillment** section: live table of every order with a "Push to Printrove" button for pending/failed ones.

## 1. Get your Printrove credentials

Printrove auth is your account email + password exchanged for a bearer
token (`POST /api/external/token`) — there's no separate API key. Use the
same email/password you log into the Printrove dashboard with.

## 2. Set Cloud Functions secrets

```bash
firebase functions:secrets:set PRINTROVE_EMAIL
firebase functions:secrets:set PRINTROVE_PASSWORD
```

## 3. Get Printrove Variant IDs and fill them in

Call Printrove's Product Library API (`GET /api/external/products`) once to
get the numeric `variant_id` for each product/size/color you sell, then
enter the matching ID in the new **Printrove Variant ID** field on each
product in admin.html. Orders can't be pushed for products missing this.

## 4. Deploy the Cloud Functions

```bash
cd functions
npm install
firebase deploy --only functions
```

**Note:** this requires Firebase's **Blaze (pay-as-you-go)** plan — Cloud
Functions that make outbound API calls (to Printrove) and use secrets need
it. The free Spark plan won't allow this.

## 5. Deploy the security rules

```bash
firebase deploy --only firestore:rules
```

These rules let guests create orders and look up a single order by ID
(their confirmation number), while only signed-in admins can browse or edit
the full orders list — status changes after creation happen only via the
Cloud Functions (which use the Admin SDK and bypass these rules entirely).

## 6. Create the Firestore indexes it asks for

The first time the scheduled tracking sync or admin orders view runs against
a non-trivial dataset, Firestore may show a "this query requires an index"
error in the browser console / function logs with a direct link — click it
to auto-create the needed composite index. This is expected on first run.

## How it works end-to-end

1. **Checkout** → customer submits the shipping form → `index.html` writes a
   doc to `orders/{orderId}` with `status: "pending"`.
2. **Push to Printrove** → `onOrderCreatePushToPrintrove` (Cloud Function)
   fires automatically, calls Printrove's Create Order API, and updates the
   order to `status: "sent_to_printrove"` (or `"failed"` with an error
   message you can see in admin.html).
3. **Manual retry** → if a push failed (bad address, missing variant, etc.),
   fix the issue and click "Push to Printrove" in admin.html — this calls
   the `retryPushOrder` callable function.
4. **Tracking sync** → `syncPrintroveTracking` runs every 30 minutes, polls
   Printrove for orders still in progress, and writes back tracking number,
   courier, and status. Printrove has no webhooks, so polling is the only
   option.
5. **Customer tracking** → the customer opens "📦 Orders" on the storefront
   and enters their Order ID to see the latest status.

## Known unknown: Get Order response shape

Printrove's public docs don't show a full example response body for
`GET /orders/{id}`. The sync function reads `tracking_number`, `courier_name`,
and `status` defensively to cover the two likely response shapes. **Log one
real response** (temporarily `console.log(JSON.stringify(remote))` inside
`syncPrintroveTracking`) and tighten the field paths once you see the actual
shape.

