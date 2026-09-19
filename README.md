# Printrove / BapStore / My Store ↔ Firebase Integration for Osani.com

This update adds **three fulfillment carts** to admin.html (Printrove,
BapStore, and My Store) and a **WhatsApp/SMS order notification** sent to
every customer right after checkout, on top of the existing Printrove
integration.

## Files

- `index.html`, `admin.html` — your two site files, edited in place
- `functions/printroveClient.js` — talks to `api.printrove.com`, handles auth token caching
- `functions/notifyClient.js` — **new**: sends the WhatsApp/SMS order confirmation via MSG91
- `functions/index.js` — Cloud Functions: store-scoped push-on-create, manual retry, scheduled tracking sync, customer notification
- `functions/package.json` — dependencies (unchanged)
- `firestore.rules` — security rules for `products` and `orders` (unchanged — already permits everything the new code needs)

## ⚠️ About the checkout error you mentioned

No screenshot actually came through with your message — only the code
files did. I improved the checkout error handling anyway (see below), but
if the error persists, open the browser console (F12 → Console tab) on
`index.html` right after it happens and send me the exact text next to
`Failed to save order [...]:` — the code now logs the Firebase error code,
which pinpoints the cause immediately (permission-denied, unavailable,
not-found, etc.).

**What I changed to help diagnose it:**
- The checkout error message now includes the Firebase error code, e.g.
  *"Something went wrong placing your order (permission-denied)."*
- The full error is always logged to the console with that same code.

**Most likely causes**, in order of likelihood, given your `firestore.rules`
already allow `orders` creation freely:
1. The Firebase config object in `index.html` doesn't match your actual
   Firebase project (wrong `projectId`/`apiKey`) — a stale copy-paste.
2. `firestore.rules` shown in your upload hasn't actually been deployed
   yet (`firebase deploy --only firestore:rules`) — the *live* rules may
   still be the default locked-down ones.
3. A Firestore composite index is missing — but that only affects reads
   (order lookup / admin table), not the `orders.add()` write itself, so
   this is less likely to be your checkout error specifically.

## What changed

**Products now belong to one of three fulfillment stores.** Set this per
product in admin.html's product form:

| Store | Field | Behavior |
|---|---|---|
| 🖨 **Printrove** | Printrove Variant ID | Auto-pushed to Printrove's API on order creation, as before |
| 📦 **BapStore** | BapStore Product/SKU ID | Tracked in its own cart; marked sent/fulfilled manually (see note below) |
| 🏬 **My Store** | — | Self-fulfilled; tracked in its own cart, marked fulfilled manually |

Existing products you haven't re-saved yet are treated as: Printrove if
they already have a Printrove Variant ID, otherwise My Store — nothing
existing silently disappears.

**admin.html** now has three tabs — 🖨 Printrove Cart / 📦 BapStore Cart /
🏬 My Store Cart — under "Orders & Fulfillment". Since one customer order
can contain items from more than one store, an order shows up in every
cart its items belong to, but each cart only shows *that store's* items,
subtotal, and status for the order:
- **Printrove cart** — unchanged from before: automatic push, "Push to
  Printrove" retry button, live tracking sync.
- **BapStore cart** — "Mark Sent to BapStore" then "Mark Fulfilled" buttons,
  since there's no BapStore API wired up (see below).
- **My Store cart** — "Mark Fulfilled" button for self-fulfilled items.

**index.html** — checkout now tags each cart item with its store, only
blocks checkout over a missing Printrove Variant ID for Printrove-tagged
items (BapStore/My Store items don't need one), and the error message
improvement described above.

**Order notification** — every new order now triggers a WhatsApp message
to the customer's phone (falling back to SMS if WhatsApp isn't set up, or
if the WhatsApp send fails), independent of which store(s) fulfill it.

## ⚠️ About BapStore

I couldn't find a public API for bapstore.com, so I haven't wired up
automatic order-pushing there the way Printrove has — the BapStore cart
above is **manual only** (you place the order on bapstore.com yourself,
then click "Mark Sent to BapStore" here to track it). If BapStore does
have a seller/dropship API with docs, send them to me and I'll build a
`bapstoreClient.js` + a third `onOrderCreatePushToBapStore` Cloud Function
mirroring `printroveClient.js`/`onOrderCreatePushToPrintrove` exactly — the
`storeStatus.bapstore` field is already there waiting for it.

## 1. Get your Printrove credentials

Printrove auth is your account email + password exchanged for a bearer
token (`POST /api/external/token`) — there's no separate API key. Use the
same email/password you log into the Printrove dashboard with.

## 2. Set up MSG91 for WhatsApp/SMS notifications

MSG91 was picked because it covers both SMS and WhatsApp from one
India-billed account. Full setup:

1. Sign up at [msg91.com](https://msg91.com) and grab your **Authkey**
   from the dashboard.
2. **For SMS:** Indian transactional SMS legally requires DLT (telecom
   regulator) registration of your sender ID and message template — MSG91's
   dashboard walks you through this. Once approved, create a matching
   "Flow" in MSG91 and note its Flow ID.
3. **For WhatsApp:** register a WhatsApp Business number through MSG91 and
   get a message template approved (free-form messages can't be sent to a
   customer who hasn't messaged you first — only pre-approved templates
   can). Note the integrated number and template name.
4. Set the secret and env vars:
   ```bash
   firebase functions:secrets:set MSG91_AUTHKEY
   ```
   Then in `functions/.env` (create this file, not committed to git):
   ```
   MSG91_SMS_FLOW_ID=your_flow_id
   MSG91_SMS_SENDER_ID=your_sender_id
   MSG91_WHATSAPP_INTEGRATED_NUMBER=91xxxxxxxxxx
   MSG91_WHATSAPP_TEMPLATE_NAME=your_template_name
   ```
   Leave any of these four blank to disable that channel — see
   `functions/notifyClient.js` for exactly how each is used, and adjust the
   template variable names there to match what MSG91 assigns once you save
   your template (their dashboard shows the exact variable keys).
5. If you'd rather use Twilio, Meta's WhatsApp Cloud API, or Gupshup
   instead, say so and I'll swap `notifyClient.js` for that provider — the
   rest of the integration (the `onOrderCreateNotifyCustomer` trigger) stays
   the same either way.

## 3. Set Cloud Functions secrets

```bash
firebase functions:secrets:set PRINTROVE_EMAIL
firebase functions:secrets:set PRINTROVE_PASSWORD
firebase functions:secrets:set MSG91_AUTHKEY
```

## 4. Tag your products and fill in IDs

In admin.html, edit each product, pick its **Fulfillment Store**, and fill
in the Printrove Variant ID (via Printrove's `GET /api/external/products`)
or BapStore Product/SKU ID as applicable. Printrove-tagged products can't
be ordered until their Variant ID is set.

## 5. Deploy the Cloud Functions

```bash
cd functions
npm install
firebase deploy --only functions
```

**Note:** this requires Firebase's **Blaze (pay-as-you-go)** plan — Cloud
Functions that make outbound API calls and use secrets need it. The free
Spark plan won't allow this.

## 6. Deploy the security rules

```bash
firebase deploy --only firestore:rules
```

Unchanged from before — guests can create orders and look up a single
order by ID, only signed-in admins can list/edit the orders collection
directly, and all automated status changes happen via the Cloud Functions
(Admin SDK, bypasses these rules).

## 7. Create the Firestore indexes it asks for

The first time the scheduled tracking sync or admin orders view runs
against a non-trivial dataset, Firestore may show a "this query requires
an index" error in the browser console / function logs with a direct link
— click it to auto-create the needed composite index. Expected on first run.

## How it works end-to-end

1. **Checkout** → customer submits the shipping form → `index.html` writes
   an `orders/{orderId}` doc with `status: "pending"` and a `storeStatus`
   map noting which of the three carts this order touches.
2. **Customer notified** → `onOrderCreateNotifyCustomer` fires immediately,
   sends a WhatsApp order confirmation (SMS fallback) to the phone number
   on the order.
3. **Push to Printrove** → `onOrderCreatePushToPrintrove` fires in parallel,
   sends only the Printrove-tagged items to Printrove's Create Order API,
   and sets `storeStatus.printrove` (plus the legacy top-level `status`,
   for pure-Printrove orders).
4. **BapStore / My Store items** → sit as `storeStatus.<store>: "pending"`
   until you manually mark them from that cart's tab in admin.html.
5. **Manual retry** → a failed Printrove push can be retried from the
   Printrove cart, same as before.
6. **Tracking sync** → `syncPrintroveTracking` runs every 30 minutes,
   updates `storeStatus.printrove` (and the top-level `status` for
   pure-Printrove orders) with tracking number, courier, and status.
7. **Customer tracking** → "📦 Orders" on the storefront still looks up by
   Order ID and shows the top-level `status` (now including a
   "Confirmed — Processing" state for orders split across stores).

## Known unknown: Get Order response shape

Printrove's public docs don't show a full example response body for
`GET /orders/{id}`. The sync function reads `tracking_number`, `courier_name`,
and `status` defensively to cover the two likely response shapes. **Log one
real response** (temporarily `console.log(JSON.stringify(remote))` inside
`syncPrintroveTracking`) and tighten the field paths once you see the actual
shape.

## 8. OSANI Business Compliance Hub (CA + Seller)

A new `compliance.html` portal adds two role-based interfaces: **Seller / Business** and **Chartered Accountant**. The storefront now exposes a **Business Hub** action that opens the portal. The portal uses the same Firebase project as the store and provides: 

- Seller account creation/login and business profile.
- CA directory with verified CA profiles.
- Service requests for GST registration/returns, company/LLP registration, startup/DPIIT compliance, MSME/Udyam, ITR, TDS/payroll, bookkeeping, trademark/IP assistance, licences and e-commerce compliance.
- Request status, assigned CA, priority, activity history and document checklist.
- CA dashboard for client requests, active clients, tasks, request acceptance and CA profile.
- Separate role-based Firestore rules for users, CA profiles, compliance requests, tasks and activities.

### CA onboarding

For security, the CA role is not self-created from the public signup form. Create the Firebase Authentication account and the corresponding `users/{uid}` document with `role: "ca"` and `verified: true`, plus a `caProfiles/{uid}` document. After that the CA can log in through the Chartered Accountant tab.

### Important next step for actual document upload

The first version provides the **document checklist/status UI**, but does not upload sensitive business documents to storage. For production use, connect Firebase Storage with per-seller/per-request access rules and add audit logging before collecting PAN, Aadhaar, bank statements or incorporation documents.
