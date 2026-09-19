/**
 * index.js
 * Firebase Cloud Functions (2nd gen) for Printrove integration + order
 * notifications, for a store that now tags every product to one of three
 * fulfillment "carts": Printrove, BapStore, or My Store (self-fulfilled).
 *
 * FIRESTORE SCHEMA (orders/{orderId}):
 *   status: "pending" | "sent_to_printrove" | "in_production" | "shipped"
 *           | "delivered" | "cancelled" | "failed" | "partially_fulfilled"
 *     — this top-level status mirrors the Printrove side of the order for
 *       backward compatibility with the customer tracking screen. For an
 *       order with NO Printrove items it just stays "pending" — check
 *       storeStatus.bapstore / storeStatus.mystore for those instead.
 *   storeStatus: {
 *     printrove: "not_applicable" | "pending" | "sent_to_printrove" | "in_production" | "shipped" | "delivered" | "cancelled" | "failed",
 *     bapstore:  "not_applicable" | "pending" | "sent_manually" | "fulfilled" | "cancelled",
 *     mystore:   "not_applicable" | "pending" | "fulfilled" | "cancelled"
 *   }
 *   printroveOrderId: number | null
 *   trackingNumber, courierName, printroveError — Printrove-specific, as before
 *   retailPrice, cod, customer: {...}
 *   items: [{ variantId, quantity, isPlain?, store: "printrove"|"bapstore"|"mystore", productId, title, unitPrice }]
 *
 * Set secrets before deploying:
 *   firebase functions:secrets:set PRINTROVE_EMAIL
 *   firebase functions:secrets:set PRINTROVE_PASSWORD
 *   firebase functions:secrets:set MSG91_AUTHKEY
 *   firebase functions:secrets:set GEMINI_API_KEY   (multilingual search — see translateClient.js)
 *   GENLOOK_API_KEY   (AI virtual try-on — see tryonClient.js)
 * Optional (order notifications — see notifyClient.js for what each does),
 * set as env vars however you manage functions/ config (e.g. a .env file):
 *   MSG91_SMS_FLOW_ID, MSG91_SMS_SENDER_ID,
 *   MSG91_WHATSAPP_INTEGRATED_NUMBER, MSG91_WHATSAPP_TEMPLATE_NAME
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const axios = require("axios");
const printrove = require("./printroveClient");
const notify = require("./notifyClient");
const tryon = require("./tryonClient");
const translate = require("./translateClient");

admin.initializeApp();

const PRINTROVE_EMAIL = defineSecret("PRINTROVE_EMAIL");
const PRINTROVE_PASSWORD = defineSecret("PRINTROVE_PASSWORD");
const MSG91_AUTHKEY = defineSecret("MSG91_AUTHKEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GENLOOK_API_KEY = defineSecret("GENLOOK_API_KEY");

// Fill these in (env vars, or a functions/.env file) once you've set up
// your MSG91 SMS flow and/or WhatsApp template. Leaving a field blank just
// disables that channel — notifyCustomerOrderPlaced() handles it gracefully.
const NOTIFY_CONFIG = {
  smsFlowId: process.env.MSG91_SMS_FLOW_ID || "",
  smsSenderId: process.env.MSG91_SMS_SENDER_ID || "",
  whatsappIntegratedNumber: process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER || "",
  whatsappTemplateName: process.env.MSG91_WHATSAPP_TEMPLATE_NAME || "",
};

// Statuses we still need to poll Printrove for updates on.
const OPEN_STATUSES = ["sent_to_printrove", "in_production", "shipped"];

/**
 * An item belongs to Printrove if it's explicitly tagged that way, or —
 * for orders placed before the store-tagging feature existed — if it has
 * a variantId and no store tag at all (old behavior: everything went to
 * Printrove).
 */
function isPrintroveItem(item) {
  return item.store ? item.store === "printrove" : !!item.variantId;
}

/**
 * Maps the Printrove-bound items of an order into the payload shape
 * Printrove's Create Order endpoint expects.
 */
function mapOrderToPrintrove(orderId, order, printroveItems) {
  return {
    reference_number: orderId, // Firestore doc ID doubles as our reference number
    retail_price: order.retailPrice,
    cod: !!order.cod,
    invoice_url: order.invoiceUrl || undefined,
    customer: {
      name: order.customer.name,
      email: order.customer.email || undefined,
      number: Number(order.customer.phone),
      address1: order.customer.address1,
      address2: order.customer.address2,
      address3: order.customer.address3 || undefined,
      pincode: order.customer.pincode,
      state: order.customer.state || undefined,
      city: order.customer.city || undefined,
      country: order.customer.country || "India",
    },
    order_products: printroveItems.map((item) => ({
      variant_id: item.variantId,
      quantity: item.quantity,
      is_plain: item.isPlain || undefined,
    })),
  };
}

/**
 * Pushes the Printrove-tagged items of an order to Printrove and returns
 * the Firestore update to apply. Does NOT write to Firestore itself, so
 * both the trigger and the callable retry function can share this logic.
 */
async function pushOrderToPrintrove(orderId, order, email, password) {
  const printroveItems = (order.items || []).filter(isPrintroveItem);
  const isPureOrder = printroveItems.length === (order.items || []).length;

  if (printroveItems.length === 0) {
    return { "storeStatus.printrove": "not_applicable" };
  }

  const token = await printrove.getToken(email, password);
  const payload = mapOrderToPrintrove(orderId, order, printroveItems);

  try {
    const result = await printrove.createOrder(token, payload);
    return {
      status: isPureOrder ? "sent_to_printrove" : "partially_fulfilled",
      "storeStatus.printrove": "sent_to_printrove",
      printroveOrderId: result.id ?? result.data?.id ?? null,
      printroveError: admin.firestore.FieldValue.delete(),
      sentToPrintroveAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  } catch (err) {
    const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    return {
      status: "failed",
      "storeStatus.printrove": "failed",
      printroveError: message,
    };
  }
}

/**
 * Trigger: fires whenever a new order document is created.
 * Pushes any Printrove-tagged items to Printrove and stores back the
 * Printrove order ID. Items tagged bapstore/mystore are left as
 * storeStatus.pending — admin.html's BapStore/My Store carts handle those.
 */
exports.onOrderCreatePushToPrintrove = onDocumentCreated(
  { document: "orders/{orderId}", secrets: [PRINTROVE_EMAIL, PRINTROVE_PASSWORD] },
  async (event) => {
    const orderId = event.params.orderId;
    const order = event.data.data();
    const ref = event.data.ref;

    try {
      const update = await pushOrderToPrintrove(orderId, order, PRINTROVE_EMAIL.value(), PRINTROVE_PASSWORD.value());
      await ref.update(update);
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`Failed to push order ${orderId} to Printrove:`, message);
      await ref.update({ status: "failed", "storeStatus.printrove": "failed", printroveError: message });
    }
  }
);

/**
 * Trigger: fires whenever a new order document is created. Sends the
 * customer a WhatsApp (falling back to SMS) order-confirmation message.
 * Runs independently of the Printrove push above, so the customer is
 * notified immediately regardless of which store(s) will fulfill the order.
 */
exports.onOrderCreateNotifyCustomer = onDocumentCreated(
  { document: "orders/{orderId}", secrets: [MSG91_AUTHKEY] },
  async (event) => {
    const orderId = event.params.orderId;
    const order = event.data.data();
    const ref = event.data.ref;

    const outcome = await notify.notifyCustomerOrderPlaced(MSG91_AUTHKEY.value(), NOTIFY_CONFIG, order, orderId);
    if (outcome.channel === "none") {
      console.error(`Order ${orderId}: customer notification not sent —`, outcome.error);
    } else {
      console.log(`Order ${orderId}: customer notified via ${outcome.channel}`);
    }
    // Non-fatal either way — a failed notification shouldn't block the order.
    await ref.update({ notification: { channel: outcome.channel, sentAt: admin.firestore.FieldValue.serverTimestamp() } }).catch(() => {});
  }
);

/**
 * Callable function: lets your admin page manually retry pushing a failed
 * order's Printrove-tagged items (e.g. a "Retry" button in admin.html).
 */
exports.retryPushOrder = onCall(
  { secrets: [PRINTROVE_EMAIL, PRINTROVE_PASSWORD] },
  async (request) => {
    const orderId = request.data?.orderId;
    if (!orderId) throw new HttpsError("invalid-argument", "orderId is required");

    const ref = admin.firestore().doc(`orders/${orderId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Order not found");

    const order = snap.data();
    const printroveItems = (order.items || []).filter(isPrintroveItem);
    if (printroveItems.length === 0) {
      throw new HttpsError("failed-precondition", "This order has no Printrove-tagged items — nothing to push.");
    }

    const update = await pushOrderToPrintrove(orderId, order, PRINTROVE_EMAIL.value(), PRINTROVE_PASSWORD.value());
    await ref.update(update);

    if (update.status === "failed") {
      throw new HttpsError("internal", update.printroveError || "Push to Printrove failed");
    }
    return { success: true, printroveOrderId: update.printroveOrderId };
  }
);

/**
 * Callable function: powers the "Try It On With AI" button on the product
 * detail page. Takes a productId + a customer-uploaded photo, fetches that
 * product's image, and asks Gemini (tryonClient.js) to generate a preview
 * of the customer wearing/using it.
 *
 * Request:  { productId: string, userPhotoBase64: string, userPhotoMimeType?: string }
 * Response: { imageBase64: string, mimeType: string }
 */
exports.generateTryOnImage = onCall(
  { secrets: [GENLOOK_API_KEY], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const { productId, userPhotoBase64, userPhotoMimeType } = request.data || {};
    if (!productId || !userPhotoBase64) {
      throw new HttpsError("invalid-argument", "productId and userPhotoBase64 are required");
    }

    try {
      const productSnap = await admin.firestore().collection("products").doc(productId).get();
      if (!productSnap.exists) {
        throw new HttpsError("not-found", `No product found with id "${productId}".`);
      }

      const product = productSnap.data();
      if (!product.img) {
        throw new HttpsError("failed-precondition", "This product has no image to try on.");
      }

      // Genlook accepts a public product image URL directly. This is better
      // than downloading the product image into the Cloud Function first.
      try {
        return await tryon.generateTryOn(GENLOOK_API_KEY.value(), {
          userPhotoBase64,
          userPhotoMimeType: userPhotoMimeType || "image/jpeg",
          productImageUrl: product.img,
          productTitle: product.title,
          productId,
        });
      } catch (err) {
        console.error(`Genlook try-on generation failed for ${productId}:`, err);
        throw new HttpsError(
          "internal",
          `Virtual try-on failed: ${err.message || "Unknown Genlook error"}`
        );
      }
    } catch (err) {
      console.error(`Try-on failed for product ${productId}:`, err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", `Unexpected try-on error: ${err.message}`);
    }
  }
);

/**
 * Callable function: powers multilingual search on the storefront. The
 * client-side search (index.html's doSearch) is a plain substring match
 * against English product text, so it calls this ONLY as a fallback when
 * a query typed in another language (or with heavy typos) returns zero
 * results — this translates it to English so the same substring match
 * can retry and actually find something.
 *
 * Request:  { query: string }
 * Response: { translatedQuery: string }
 */
exports.translateSearchQuery = onCall(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 20 },
  async (request) => {
    const query = (request.data?.query || "").trim();
    if (!query) throw new HttpsError("invalid-argument", "query is required");

    try {
      const translatedQuery = await translate.translateToEnglish(GEMINI_API_KEY.value(), query);
      return { translatedQuery };
    } catch (err) {
      console.error(`Search translation failed for "${query}":`, err.message);
      throw new HttpsError("internal", `Search translation failed: ${err.message}`);
    }
  }
);

/**
 * Scheduled function: polls Printrove every 30 minutes for tracking/status
 * updates on any order that isn't finished yet, and writes them back.
 * (Printrove has no webhooks, so polling is the only option.)
 */
exports.syncPrintroveTracking = onSchedule(
  { schedule: "every 30 minutes", secrets: [PRINTROVE_EMAIL, PRINTROVE_PASSWORD] },
  async () => {
    const db = admin.firestore();
    const token = await printrove.getToken(PRINTROVE_EMAIL.value(), PRINTROVE_PASSWORD.value());

    const snap = await db
      .collection("orders")
      .where("status", "in", OPEN_STATUSES)
      .where("printroveOrderId", "!=", null)
      .get();

    if (snap.empty) {
      console.log("No open orders to sync.");
      return;
    }

    await Promise.all(
      snap.docs.map(async (doc) => {
        const order = doc.data();
        try {
          const remote = await printrove.getOrder(token, order.printroveOrderId);
          // NOTE: Printrove's docs don't publish the exact Get Order response
          // shape, so this reads a few plausible field names defensively.
          // Log `remote` once in production and tighten this mapping to match.
          const trackingNumber = remote.tracking_number ?? remote.data?.tracking_number ?? null;
          const courierName = remote.courier_name ?? remote.data?.courier_name ?? null;
          const remoteStatus = (remote.status ?? remote.data?.status ?? "").toLowerCase();

          const statusMap = {
            shipped: "shipped",
            in_production: "in_production",
            delivered: "delivered",
            cancelled: "cancelled",
          };

          const update = {
            lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (trackingNumber) update.trackingNumber = trackingNumber;
          if (courierName) update.courierName = courierName;
          if (statusMap[remoteStatus]) {
            // Only overwrite the top-level status if this was a pure-Printrove
            // order (i.e. it's currently reflecting the Printrove state) —
            // a "partially_fulfilled" mixed order keeps that label at the
            // top level, with the detail living in storeStatus.printrove.
            update["storeStatus.printrove"] = statusMap[remoteStatus];
            if (order.status !== "partially_fulfilled") {
              update.status = statusMap[remoteStatus];
            }
          }

          await doc.ref.update(update);
        } catch (err) {
          console.error(`Failed to sync order ${doc.id}:`, err.response?.data || err.message);
        }
      })
    );
  }
);
