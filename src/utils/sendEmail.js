import nodemailer from "nodemailer";
import dns from "dns";

/* ── Prefer IPv4 globally — Render's egress has no IPv6 route,
   so DNS A records must be used. Without this, nodemailer can
   pick an AAAA record and fail with ESOCKET ENETUNREACH. */
dns.setDefaultResultOrder("ipv4first");

/* ── Strict IPv4 lookup for SMTP sockets ── */
const ipv4OnlyLookup = (hostname, opts, cb) => {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  return dns.lookup(hostname, { ...opts, family: 4, all: false }, cb);
};

/* ── Build Hostinger transporter (pooled, IPv4-only, with timeouts) ── */
const makeHostingerTransport = () =>
  nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || "smtp.hostinger.com",
    port:   Number(process.env.EMAIL_PORT) || 465,
    secure: true,
    pool:   true,
    maxConnections: 3,
    maxMessages:    100,
    connectionTimeout: 10000,
    greetingTimeout:   8000,
    socketTimeout:     20000,
    dnsLookup: ipv4OnlyLookup,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
  });

/* ── Build Gmail transporter (pooled, IPv4-only, with timeouts) ── */
const makeGmailTransport = () =>
  nodemailer.createTransport({
    host:   "smtp.gmail.com",
    port:   465,
    secure: true,
    pool:    true,
    maxConnections: 3,
    maxMessages:    100,
    connectionTimeout: 10000,
    greetingTimeout:   8000,
    socketTimeout:     20000,
    dnsLookup: ipv4OnlyLookup,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASS,
    },
    tls: { rejectUnauthorized: false },
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

  const errors = [];

  /* 1️⃣  Try Hostinger (cached transporter, no verify() round-trip) */
  if (hostingerReady) {
    try {
      const info = await getHostinger().sendMail(buildOptions(process.env.EMAIL_USER));
      console.log(`[sendEmail] Sent via Hostinger to ${to}`);
      return info;
    } catch (err) {
      const detail = `${err.code || ""} ${err.responseCode || ""} ${err.response || err.message || ""}`.trim();
      console.warn(`[sendEmail] Hostinger failed: ${detail}`);
      errors.push(`Hostinger → ${detail}`);
      try { hostingerTransporter?.close(); } catch {}
      hostingerTransporter = null;
    }
  } else {
    errors.push("Hostinger → not configured (missing EMAIL_USER/EMAIL_PASS/EMAIL_HOST)");
  }

  /* 2️⃣  Fallback: Gmail (cached transporter) */
  if (gmailReady) {
    try {
      const info = await getGmail().sendMail(buildOptions(process.env.GMAIL_USER));
      console.log(`[sendEmail] Sent via Gmail to ${to}`);
      return info;
    } catch (err) {
      const detail = `${err.code || ""} ${err.responseCode || ""} ${err.response || err.message || ""}`.trim();
      console.error(`[sendEmail] Gmail failed: ${detail}`);
      errors.push(`Gmail → ${detail}`);
      try { gmailTransporter?.close(); } catch {}
      gmailTransporter = null;
    }
  } else {
    errors.push("Gmail → not configured (missing GMAIL_USER/GMAIL_APP_PASS)");
  }

  throw new Error(`Email delivery failed. ${errors.join(" | ")}`);
};

export default sendEmail;
