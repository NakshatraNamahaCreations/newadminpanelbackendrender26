import nodemailer from "nodemailer";
import dns from "node:dns";

/* Force IPv4 globally — fixes ENETUNREACH on networks with no IPv6 route. */
dns.setDefaultResultOrder("ipv4first");

/* Custom DNS resolver that only returns IPv4 (A) records.
   nodemailer accepts an `dnsLookup` / we pass via `lookup` on the socket. */
const ipv4Only = (hostname, opts, cb) => {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  dns.lookup(hostname, { family: 4, all: false }, cb);
};

const COMMON_TIMEOUTS = {
  connectionTimeout: 15000,
  greetingTimeout:   15000,
  socketTimeout:     20000,
};

/* Two Gmail transports — try SSL/465 first, then STARTTLS/587 if 465 is blocked. */
const gmailTransports = () => ([
  nodemailer.createTransport({
    host:    "smtp.gmail.com",
    port:    465,
    secure:  true,
    auth:    { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS },
    tls:     { rejectUnauthorized: false },
    lookup:  ipv4Only,
    ...COMMON_TIMEOUTS,
  }),
  nodemailer.createTransport({
    host:    "smtp.gmail.com",
    port:    587,
    secure:  false,
    requireTLS: true,
    auth:    { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS },
    tls:     { rejectUnauthorized: false },
    lookup:  ipv4Only,
    ...COMMON_TIMEOUTS,
  }),
]);

/* Two Hostinger transports — same idea: 465 then 587. */
const hostingerTransports = () => ([
  nodemailer.createTransport({
    host:    process.env.EMAIL_HOST || "smtp.hostinger.com",
    port:    Number(process.env.EMAIL_PORT) || 465,
    secure:  true,
    auth:    { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    tls:     { rejectUnauthorized: false },
    lookup:  ipv4Only,
    ...COMMON_TIMEOUTS,
  }),
  nodemailer.createTransport({
    host:    process.env.EMAIL_HOST || "smtp.hostinger.com",
    port:    587,
    secure:  false,
    requireTLS: true,
    auth:    { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    tls:     { rejectUnauthorized: false },
    lookup:  ipv4Only,
    ...COMMON_TIMEOUTS,
  }),
]);

const fmtErr = (label, err) => {
  const code     = err?.code     ? ` code=${err.code}`     : "";
  const command  = err?.command  ? ` cmd=${err.command}`   : "";
  const response = err?.response ? ` resp=${err.response}` : "";
  return `${label}: ${err?.message || err}${code}${command}${response}`;
};

/**
 * Send an email. Tries Gmail (465 → 587), then Hostinger (465 → 587).
 * On total failure, throws an Error whose message contains every attempt's
 * underlying error so the caller can surface them in the HTTP response.
 */
const sendEmail = async ({ to, subject, html, replyTo, cc, bcc, attachments }) => {
  const hostingerReady = process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_HOST;
  const gmailReady     = process.env.GMAIL_USER && process.env.GMAIL_APP_PASS;

  if (!hostingerReady && !gmailReady) {
    throw new Error(
      "No email credentials configured on the server. " +
      "Set EMAIL_USER/EMAIL_PASS/EMAIL_HOST (Hostinger) or GMAIL_USER/GMAIL_APP_PASS (Gmail)."
    );
  }

  const buildOptions = (fromAddr) => {
    const opts = { from: `"NNC Nakshatra Namaha Creations" <${fromAddr}>`, to, subject, html };
    if (replyTo)                       opts.replyTo     = replyTo;
    if (cc)                            opts.cc          = cc;
    if (bcc)                           opts.bcc         = bcc;
    if (attachments && attachments.length) opts.attachments = attachments;
    return opts;
  };

  const errors = [];

  const attempts = [];
  if (gmailReady) {
    gmailTransports().forEach((t, i) => attempts.push({
      label: `Gmail:${i === 0 ? "465" : "587"}`,
      transporter: t,
      from: process.env.GMAIL_USER,
      transportName: "gmail",
    }));
  } else {
    errors.push("Gmail: not configured (GMAIL_USER/GMAIL_APP_PASS missing)");
  }
  if (hostingerReady) {
    hostingerTransports().forEach((t, i) => attempts.push({
      label: `Hostinger:${i === 0 ? "465" : "587"}`,
      transporter: t,
      from: process.env.EMAIL_USER,
      transportName: "hostinger",
    }));
  } else {
    errors.push("Hostinger: not configured (EMAIL_USER/EMAIL_PASS/EMAIL_HOST missing)");
  }

  for (const a of attempts) {
    try {
      const info = await a.transporter.sendMail(buildOptions(a.from));
      console.log(`[sendEmail] Sent via ${a.label} to ${to} — id=${info.messageId}`);
      return { ...info, transport: a.transportName };
    } catch (err) {
      const line = fmtErr(a.label, err);
      console.warn(`[sendEmail] ${line}`);
      errors.push(line);
    }
  }

  throw new Error(`Email delivery failed. ${errors.join(" | ")}`);
};

export default sendEmail;
