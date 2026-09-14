/**
 * printroveClient.js
 * Thin wrapper around the Printrove REST API (https://api.printrove.com/docs).
 *
 * Auth model: Printrove has no OAuth/API-key concept — you POST your account
 * email + password to /api/external/token and get back a bearer token that
 * is valid for a long time (the example response is valid ~1 year). We cache
 * that token in Firestore (config/printrove) so we don't re-authenticate on
 * every call, and only refresh when it's missing or close to expiry.
 */

const axios = require("axios");
const admin = require("firebase-admin");

const BASE_URL = "https://api.printrove.com/api/external";
const TOKEN_DOC = "config/printrove"; // Firestore path where we cache the token

/**
 * Fetches a fresh token from Printrove using the account credentials.
 */
async function fetchNewToken(email, password) {
  const res = await axios.post(`${BASE_URL}/token`, { email, password }, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  // Response shape per Printrove docs: { access_token, expires_at }
  return { token: res.data.access_token, expiresAt: res.data.expires_at };
}

/**
 * Returns a valid bearer token, refreshing + caching it in Firestore if needed.
 * email/password come from Cloud Functions secrets (see index.js).
 */
async function getToken(email, password) {
  const db = admin.firestore();
  const ref = db.doc(TOKEN_DOC);
  const snap = await ref.get();

  if (snap.exists) {
    const { token, expiresAt } = snap.data();
    const expiryMs = new Date(expiresAt).getTime();
    // Refresh 1 day before actual expiry to be safe
    if (token && expiryMs - Date.now() > 24 * 60 * 60 * 1000) {
      return token;
    }
  }

  const { token, expiresAt } = await fetchNewToken(email, password);
  await ref.set({ token, expiresAt, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Creates an order on Printrove.
 * `order` must already be shaped to match Printrove's Create Order payload
 * (see mapOrderToPrintrove in index.js for how we build this from our own
 * Firestore order documents).
 */
async function createOrder(token, order) {
  const res = await axios.post(`${BASE_URL}/orders`, order, { headers: authHeaders(token) });
  return res.data;
}

/**
 * Fetches a single order from Printrove by its Printrove order ID.
 */
async function getOrder(token, printroveOrderId) {
  const res = await axios.get(`${BASE_URL}/orders/${printroveOrderId}`, { headers: authHeaders(token) });
  return res.data;
}

/**
 * Lists orders, optionally filtered by tracking or reference number.
 */
async function listOrders(token, { page = 1, perPage = 20, trackingNumber, referenceNumber } = {}) {
  const res = await axios.get(`${BASE_URL}/orders`, {
    headers: authHeaders(token),
    params: {
      page,
      per_page: perPage,
      tracking_number: trackingNumber,
      reference_number: referenceNumber,
    },
  });
  return res.data;
}

/**
 * Checks pincode serviceability before creating an order (optional but
 * useful to avoid creating orders that will just fail on Printrove's side).
 */
async function checkServiceability(token, { country, pincode, weight, cod }) {
  const res = await axios.get(`${BASE_URL}/serviceability`, {
    headers: authHeaders(token),
    params: { country, pincode, weight, cod },
  });
  return res.data;
}

module.exports = {
  getToken,
  createOrder,
  getOrder,
  listOrders,
  checkServiceability,
};
