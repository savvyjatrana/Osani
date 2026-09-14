/**
 * index.js
 * Firebase Cloud Functions (2nd gen) for Printrove integration.
 *
 * ASSUMED FIRESTORE SCHEMA (adjust field names to match your real DB —
 * this is a placeholder since your actual index/admin files weren't
 * available when this was written):
 *
 * orders/{orderId}
 *   status: "pending" | "sent_to_printrove" | "in_production" | "shipped" | "delivered" | "cancelled" | "failed"
 *   printroveOrderId: number | null
 *   trackingNumber: string | null
 *   courierName: string | null
 *   retailPrice: number
 *   cod: boolean
 *   customer: {
 *     name, email, phone, address1, address2, address3,
 *     pincode, state, city, country
 *   }
 *   items: [{ variantId: number, quantity: number, isPlain?: boolean }]
 *   invoiceUrl?: string
 *   printroveError?: string
 *
 * Set secrets before deploying:
 *   firebase functions:secrets:set PRINTROVE_EMAIL
 *   firebase functions:secrets:set PRINTROVE_PASSWORD
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const printrove = require("./printroveClient");

admin.initializeApp();

const PRINTROVE_EMAIL = defineSecret("PRINTROVE_EMAIL");
const PRINTROVE_PASSWORD = defineSecret("PRINTROVE_PASSWORD");

// Statuses we still need to poll Printrove for updates on.
const OPEN_STATUSES = ["sent_to_printrove", "in_production", "shipped"];

/**
 * Maps one of our Firestore order docs into the payload shape Printrove's
 * Create Order endpoint expects. Adjust the field mapping here once you
 * share your real schema.
 */
function mapOrderToPrintrove(orderId, order) {
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
    order_products: order.items.map((item) => ({
      variant_id: item.variantId,
      quantity: item.quantity,
      is_plain: item.isPlain || undefined,
    })),
  };
}

/**
 * Trigger: fires whenever a new order document is created.
 * Pushes the order to Printrove and stores back the Printrove order ID.
 */
exports.onOrderCreatePushToPrintrove = onDocumentCreated(
  { document: "orders/{orderId}", secrets: [PRINTROVE_EMAIL, PRINTROVE_PASSWORD] },
  async (event) => {
    const orderId = event.params.orderId;
    const order = event.data.data();
    const ref = event.data.ref;

    try {
      const token = await printrove.getToken(PRINTROVE_EMAIL.value(), PRINTROVE_PASSWORD.value());
      const payload = mapOrderToPrintrove(orderId, order);
      const result = await printrove.createOrder(token, payload);

      await ref.update({
        status: "sent_to_printrove",
        printroveOrderId: result.id ?? result.data?.id ?? null,
        printroveError: admin.firestore.FieldValue.delete(),
        sentToPrintroveAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`Failed to push order ${orderId} to Printrove:`, message);
      await ref.update({ status: "failed", printroveError: message });
    }
  }
);

/**
 * Callable function: lets your admin page manually retry pushing a failed
 * order (e.g. a "Retry" button next to a failed order in your admin UI).
 */
exports.retryPushOrder = onCall(
  { secrets: [PRINTROVE_EMAIL, PRINTROVE_PASSWORD] },
  async (request) => {
    const orderId = request.data?.orderId;
    if (!orderId) throw new HttpsError("invalid-argument", "orderId is required");

    const ref = admin.firestore().doc(`orders/${orderId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Order not found");

    const token = await printrove.getToken(PRINTROVE_EMAIL.value(), PRINTROVE_PASSWORD.value());
    const payload = mapOrderToPrintrove(orderId, snap.data());

    try {
      const result = await printrove.createOrder(token, payload);
      await ref.update({
        status: "sent_to_printrove",
        printroveOrderId: result.id ?? result.data?.id ?? null,
        printroveError: admin.firestore.FieldValue.delete(),
      });
      return { success: true, printroveOrderId: result.id ?? result.data?.id };
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      await ref.update({ status: "failed", printroveError: message });
      throw new HttpsError("internal", message);
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
          if (statusMap[remoteStatus]) update.status = statusMap[remoteStatus];

          await doc.ref.update(update);
        } catch (err) {
          console.error(`Failed to sync order ${doc.id}:`, err.response?.data || err.message);
        }
      })
    );
  }
);
