import nodemailer from "nodemailer";
import dns from "dns";

/* Render's free-tier egress only has IPv4 routing.
   Without this, DNS may return an AAAA record and the
   SMTP socket fails with ESOCKET ENETUNREACH before auth. */
dns.setDefaultResultOrder("ipv4first");

/* ── Build Hostinger transporter ── */
const makeHostingerTransport = () =>
  nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || "smtp.hostinger.com",
    port:   Number(process.env.EMAIL_PORT) || 465,
    secure: true,           // SSL on 465
    family: 4,              // force IPv4
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
  });

/* ── Build Gmail transporter ── */
const makeGmailTransport = () =>
  nodemailer.createTransport({
    host:   "smtp.gmail.com",
    port:   465,
    secure: true,
    family: 4,              // force IPv4
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASS,
    },
    tls: { rejectUnauthorized: false },
  });

/**
 * Send an email.
 * Tries Hostinger SMTP first; falls back to Gmail if Hostinger fails.
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

  /* 1️⃣  Try Hostinger */
  if (hostingerReady) {
    try {
      const transporter = makeHostingerTransport();
      await transporter.verify();                          // quick auth check
      const info = await transporter.sendMail(buildOptions(process.env.EMAIL_USER));
      console.log(`[sendEmail] Sent via Hostinger to ${to}`);
      return info;
    } catch (err) {
      const detail = `${err.code || ""} ${err.responseCode || ""} ${err.response || err.message || ""}`.trim();
      console.warn(`[sendEmail] Hostinger failed: ${detail}`);
    }
  }

  /* 2️⃣  Fallback: Gmail */
  if (gmailReady) {
    try {
      const transporter = makeGmailTransport();
      const info = await transporter.sendMail(buildOptions(process.env.GMAIL_USER));
      console.log(`[sendEmail] Sent via Gmail to ${to}`);
      return info;
    } catch (err) {
      const detail = `${err.code || ""} ${err.responseCode || ""} ${err.response || err.message || ""}`.trim();
      console.error(`[sendEmail] Gmail also failed: ${detail}`);
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
