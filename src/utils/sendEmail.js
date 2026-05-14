import nodemailer from "nodemailer";

/* ── Build Hostinger transporter (SSL on 465) ── */
const makeHostingerTransport = () =>
  nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || "smtp.hostinger.com",
    port:   Number(process.env.EMAIL_PORT) || 465,
    secure: true,
    family: 4,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
  });

/* ── Build Gmail transporter (uses STARTTLS on 587 under the hood) ── */
const makeGmailTransport = () =>
  nodemailer.createTransport({
    service: "gmail",
    family:  4,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
  });

const fmtErr = (label, err) => {
  const code     = err?.code     ? ` code=${err.code}`     : "";
  const command  = err?.command  ? ` cmd=${err.command}`   : "";
  const response = err?.response ? ` resp=${err.response}` : "";
  return `${label}: ${err?.message || err}${code}${command}${response}`;
};

/**
 * Send an email. Tries Hostinger first, then Gmail.
 * On total failure, throws an Error whose message contains BOTH underlying errors
 * so the caller (controller) can surface them in the HTTP response.
 */
const sendEmail = async ({ to, subject, html, replyTo, cc, bcc }) => {
  const hostingerReady = process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_HOST;
  const gmailReady     = process.env.GMAIL_USER && process.env.GMAIL_APP_PASS;

  if (!hostingerReady && !gmailReady) {
    throw new Error(
      "No email credentials configured on the server. " +
      "Set EMAIL_USER/EMAIL_PASS/EMAIL_HOST (Hostinger) or GMAIL_USER/GMAIL_APP_PASS (Gmail) " +
      "in the deployment environment (e.g. Render → Environment)."
    );
  }

  const buildOptions = (fromAddr) => {
    const opts = { from: `"NNC Nakshatra Namaha Creations" <${fromAddr}>`, to, subject, html };
    if (replyTo) opts.replyTo = replyTo;
    if (cc)      opts.cc      = cc;
    if (bcc)     opts.bcc     = bcc;
    return opts;
  };

  const errors = [];

  /* 1️⃣  Try Gmail FIRST — App Passwords work reliably from Render's egress.
         Hostinger SMTP is often blocked/throttled on cloud hosts. */
  if (gmailReady) {
    try {
      const transporter = makeGmailTransport();
      const info = await transporter.sendMail(buildOptions(process.env.GMAIL_USER));
      console.log(`[sendEmail] Sent via Gmail to ${to} — id=${info.messageId}`);
      return { ...info, transport: "gmail" };
    } catch (err) {
      const line = fmtErr("Gmail", err);
      console.warn(`[sendEmail] ${line}`);
      errors.push(line);
    }
  } else {
    errors.push("Gmail: not configured (GMAIL_USER/GMAIL_APP_PASS missing)");
  }

  /* 2️⃣  Fallback: Hostinger SMTP */
  if (hostingerReady) {
    try {
      const transporter = makeHostingerTransport();
      const info = await transporter.sendMail(buildOptions(process.env.EMAIL_USER));
      console.log(`[sendEmail] Sent via Hostinger to ${to} — id=${info.messageId}`);
      return { ...info, transport: "hostinger" };
    } catch (err) {
      const line = fmtErr("Hostinger", err);
      console.error(`[sendEmail] ${line}`);
      errors.push(line);
    }
  } else {
    errors.push("Hostinger: not configured (EMAIL_USER/EMAIL_PASS/EMAIL_HOST missing)");
  }

  throw new Error(`Email delivery failed. ${errors.join(" | ")}`);
};

export default sendEmail;
