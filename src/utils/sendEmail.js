import nodemailer from "nodemailer";

/* ── Build Hostinger transporter (pooled, with timeouts) ── */
const makeHostingerTransport = () =>
  nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || "smtp.hostinger.com",
    port:   465,
    secure: true,
    family: 4,
    pool:   true,
    maxConnections: 3,
    maxMessages:    100,
    connectionTimeout: 7000,   // 7s to open TCP
    greetingTimeout:   5000,   // 5s for SMTP greeting
    socketTimeout:     15000,  // 15s overall socket idle limit
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
  });

/* ── Build Gmail transporter (pooled, with timeouts) ── */
const makeGmailTransport = () =>
  nodemailer.createTransport({
    service: "gmail",
    pool:    true,
    maxConnections: 3,
    maxMessages:    100,
    connectionTimeout: 7000,
    greetingTimeout:   5000,
    socketTimeout:     15000,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASS,
    },
  });

/* ── Cached singleton transporters (created lazily on first use) ── */
let hostingerTransporter = null;
let gmailTransporter     = null;

const getHostinger = () => {
  if (!hostingerTransporter) hostingerTransporter = makeHostingerTransport();
  return hostingerTransporter;
};
const getGmail = () => {
  if (!gmailTransporter) gmailTransporter = makeGmailTransport();
  return gmailTransporter;
};

/**
 * Send an email.
 * Tries Hostinger SMTP first; falls back to Gmail if Hostinger fails.
 * Uses pooled, cached transporters so subsequent sends reuse the TCP connection.
 */
const sendEmail = async ({ to, subject, html, replyTo, cc, bcc }) => {
  const hostingerReady =
    process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_HOST;
  const gmailReady =
    process.env.GMAIL_USER && process.env.GMAIL_APP_PASS;

  if (!hostingerReady && !gmailReady) {
    throw new Error("No email credentials configured. Set EMAIL_USER/EMAIL_PASS or GMAIL_USER/GMAIL_APP_PASS in .env");
  }

  const buildOptions = (fromAddr) => {
    const opts = { from: `"NNC Nakshatra Namaha Creations" <${fromAddr}>`, to, subject, html };
    if (replyTo) opts.replyTo = replyTo;
    if (cc)      opts.cc      = cc;
    if (bcc)     opts.bcc     = bcc;
    return opts;
  };

  /* 1️⃣  Try Hostinger (cached transporter, no verify() round-trip) */
  if (hostingerReady) {
    try {
      const info = await getHostinger().sendMail(buildOptions(process.env.EMAIL_USER));
      console.log(`[sendEmail] Sent via Hostinger to ${to}`);
      return info;
    } catch (err) {
      console.warn(`[sendEmail] Hostinger failed (${err.message}), trying Gmail…`);
      // Drop the dead pool — next call will rebuild
      try { hostingerTransporter?.close(); } catch {}
      hostingerTransporter = null;
    }
  }

  /* 2️⃣  Fallback: Gmail (cached transporter) */
  if (gmailReady) {
    try {
      const info = await getGmail().sendMail(buildOptions(process.env.GMAIL_USER));
      console.log(`[sendEmail] Sent via Gmail to ${to}`);
      return info;
    } catch (err) {
      console.error(`[sendEmail] Gmail also failed: ${err.message}`);
      try { gmailTransporter?.close(); } catch {}
      gmailTransporter = null;
      throw new Error(
        `Email delivery failed.\n` +
        `Hostinger: check EMAIL_USER/EMAIL_PASS and that SMTP is enabled in hPanel.\n` +
        `Gmail: enable 2-Step Verification on ${process.env.GMAIL_USER} and regenerate the App Password.`
      );
    }
  }

  throw new Error("All email transports failed.");
};

export default sendEmail;
