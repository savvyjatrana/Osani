const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { Resend } = require("resend");

admin.initializeApp();
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

exports.onOrderCreateSendEmail = onDocumentCreated(
  { document: "orders/{orderId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const orderId = event.params.orderId;
    const order = event.data.data();
    const customerEmail = order.customer?.email;

    if (!customerEmail) {
      console.log(`Order ${orderId}: No email provided by customer.`);
      return;
    }

    const resend = new Resend(RESEND_API_KEY.value());
    const customerName = order.customer?.name || "Customer";
    const totalAmount = (order.retailPrice || 0).toLocaleString("en-IN");

    try {
      await resend.emails.send({
        from: "Osani.com <orders@yourdomain.com>", // Make sure to use your verified Resend domain
        to: [customerEmail],
        subject: `Order Confirmation #${orderId} - Osani.com`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #3d282b; padding: 20px;">
            <h2 style="color: #b76e79;">Thank you for your order, ${customerName}!</h2>
            <p>We’ve received your order successfully. Here are your order details:</p>
            <div style="background: #fcf8f7; border: 1px dashed #b76e79; padding: 15px; border-radius: 6px; margin: 20px 0;">
              <p><strong>Order ID:</strong> ${orderId}</p>
              <p><strong>Total Amount:</strong> ₹${totalAmount}</p>
            </div>
            <p>If you have any questions, reach out to support@osani.com.</p>
            <p>Warm regards,<br><strong>Osani.com Team</strong></p>
          </div>
        `,
      });
      console.log(`Confirmation email successfully sent to ${customerEmail}`);
    } catch (err) {
      console.error(`Failed to send email for order ${orderId}:`, err);
    }
  }
);
