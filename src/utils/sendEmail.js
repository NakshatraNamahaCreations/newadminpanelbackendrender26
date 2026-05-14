import { Resend } from "resend";

/*  Sends transactional email via Resend's HTTPS API (port 443).
    We use this instead of SMTP because Render's free tier blocks
    outbound SMTP (ports 25/465/587) — confirmed by ETIMEDOUT on
    every SMTP attempt. Resend works over plain HTTPS, which Render
    does NOT block.

    Setup checklist (one-time, on resend.com):
      1. Sign up → Dashboard → API Keys → "Create API Key" (full access).
      2. Domains → "Add Domain" → enter nakshatranamahacreations.com
         and add the DNS records (SPF, DKIM, DMARC) shown by Resend.
         While unverified you can only send to YOUR signed-up email.
      3. Set on Render:  RESEND_API_KEY=re_xxxxxxxxxxxxx
         (and optional EMAIL_FROM, EMAIL_FROM_NAME) and redeploy.
*/

let resend = null;
const getResend = () => {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set in environment");
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
};

const FROM_NAME    = process.env.EMAIL_FROM_NAME || "NNC Nakshatra Namaha Creations";
const FROM_ADDRESS = process.env.EMAIL_FROM      || "info@nakshatranamahacreations.com";

/**
 * Send an email via Resend.
 * Keeps the original signature so callers (quotation controller, etc.)
 * don't need to change anything.
 */
const sendEmail = async ({ to, subject, html, replyTo, cc, bcc }) => {
  if (!to)      throw new Error("sendEmail: 'to' is required");
  if (!subject) throw new Error("sendEmail: 'subject' is required");
  if (!html)    throw new Error("sendEmail: 'html' is required");

  const payload = {
    from:    `${FROM_NAME} <${FROM_ADDRESS}>`,
    to:      Array.isArray(to)  ? to  : [to],
    subject,
    html,
  };
  if (replyTo) payload.reply_to = replyTo;
  if (cc)      payload.cc       = Array.isArray(cc)  ? cc  : [cc];
  if (bcc)     payload.bcc      = Array.isArray(bcc) ? bcc : [bcc];

  try {
    const { data, error } = await getResend().emails.send(payload);
    if (error) {
      const msg = error.message || error.name || JSON.stringify(error);
      console.error(`[sendEmail] Resend error → ${msg}`);
      throw new Error(`Resend → ${msg}`);
    }
    console.log(`[sendEmail] Sent via Resend to ${to} (id: ${data?.id})`);
    return data;
  } catch (err) {
    // Network / config errors surface here
    if (!err.message?.startsWith("Resend →")) {
      console.error(`[sendEmail] Resend exception → ${err.message}`);
      throw new Error(`Resend → ${err.message}`);
    }
    throw err;
  }
};

export default sendEmail;
