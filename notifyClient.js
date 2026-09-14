/**
 * notifyClient.js
 * Sends order-confirmation WhatsApp/SMS messages via MSG91
 * (https://msg91.com) — chosen because it supports both SMS and WhatsApp
 * from one Indian-billed account, which fits an India-based store better
 * than Twilio or a bare Meta Cloud API setup.
 *
 * IMPORTANT — things you must set up in your MSG91 dashboard before this
 * will actually send anything (this file can't do these for you):
 *
 * 1. SMS requires DLT registration (mandatory for any transactional SMS to
 *    Indian numbers). Register your sender ID + message template with your
 *    telecom DLT provider, then create a matching Flow in MSG91 and copy
 *    its Template/Flow ID into MSG91_SMS_FLOW_ID.
 * 2. WhatsApp requires a MSG91-provisioned WhatsApp Business number
 *    (MSG91_WHATSAPP_INTEGRATED_NUMBER) and a pre-approved message
 *    template (MSG91_WHATSAPP_TEMPLATE_NAME) — free-form WhatsApp
 *    messages cannot be sent to a customer who hasn't messaged you first.
 * 3. Both flows/templates need placeholders for the variables this file
 *    fills in: customer name, order ID, and total amount. Name your
 *    template variables to match, then adjust the `recipients`/
 *    `template_params` mapping below if MSG91 assigns them different keys
 *    than assumed here (their dashboard shows the exact variable names
 *    once you save a template — this is a placeholder like the Printrove
 *    "Get Order" response shape in printroveClient.js).
 *
 * If WhatsApp send fails (e.g. template not approved yet), this module
 * automatically falls back to SMS so the customer still gets *something*.
 */

const axios = require("axios");

const SMS_URL = "https://control.msg91.com/api/v5/flow/";
const WHATSAPP_URL = "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";

function authHeaders(authkey) {
  return { authkey, "Content-Type": "application/json" };
}

/**
 * Sends the WhatsApp order-confirmation template message.
 * `integratedNumber` is the MSG91-provisioned WhatsApp sender number.
 */
async function sendWhatsAppOrderConfirmation(authkey, {
  integratedNumber,
  templateName,
  phone, // 10-digit Indian mobile number, no country code
  customerName,
  orderId,
  total,
}) {
  const payload = {
    integrated_number: integratedNumber,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: templateName,
        language: { code: "en", policy: "deterministic" },
        namespace: undefined, // fill in if your MSG91 template requires a namespace
        to_and_components: [
          {
            to: [`91${phone}`],
            components: {
              body_1: { type: "text", value: customerName },
              body_2: { type: "text", value: orderId },
              body_3: { type: "text", value: `₹${total}` },
            },
          },
        ],
      },
    },
  };

  const res = await axios.post(WHATSAPP_URL, payload, { headers: authHeaders(authkey) });
  return res.data;
}

/**
 * Sends the SMS order-confirmation flow. Used as the primary channel when
 * WhatsApp isn't configured, and as a fallback if a WhatsApp send fails.
 */
async function sendSmsOrderConfirmation(authkey, {
  flowId,
  senderId,
  phone,
  customerName,
  orderId,
  total,
}) {
  const payload = {
    template_id: flowId,
    short_url: "0",
    recipients: [
      {
        mobiles: `91${phone}`,
        name: customerName,
        order_id: orderId,
        amount: `${total}`,
      },
    ],
  };
  if (senderId) payload.sender = senderId;

  const res = await axios.post(SMS_URL, payload, { headers: authHeaders(authkey) });
  return res.data;
}

/**
 * High-level helper: tries WhatsApp first (if configured), falls back to
 * SMS (if configured) on failure or if WhatsApp isn't set up at all.
 * Returns { channel: "whatsapp"|"sms"|"none", result?, error? }.
 */
async function notifyCustomerOrderPlaced(authkey, config, order, orderId) {
  const phone = order.customer?.phone;
  if (!phone) return { channel: "none", error: "Order has no customer phone number" };

  const vars = {
    phone,
    customerName: order.customer?.name || "Customer",
    orderId,
    total: (order.retailPrice || 0).toLocaleString("en-IN"),
  };

  if (config.whatsappIntegratedNumber && config.whatsappTemplateName) {
    try {
      const result = await sendWhatsAppOrderConfirmation(authkey, {
        integratedNumber: config.whatsappIntegratedNumber,
        templateName: config.whatsappTemplateName,
        ...vars,
      });
      return { channel: "whatsapp", result };
    } catch (err) {
      console.error("WhatsApp notification failed, falling back to SMS:", err.response?.data || err.message);
      // fall through to SMS
    }
  }

  if (config.smsFlowId) {
    try {
      const result = await sendSmsOrderConfirmation(authkey, {
        flowId: config.smsFlowId,
        senderId: config.smsSenderId,
        ...vars,
      });
      return { channel: "sms", result };
    } catch (err) {
      console.error("SMS notification failed:", err.response?.data || err.message);
      return { channel: "none", error: err.response?.data || err.message };
    }
  }

  return { channel: "none", error: "No WhatsApp or SMS channel configured" };
}

module.exports = {
  sendWhatsAppOrderConfirmation,
  sendSmsOrderConfirmation,
  notifyCustomerOrderPlaced,
};
