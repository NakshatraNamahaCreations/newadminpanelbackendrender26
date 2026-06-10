/**
 * PUBLIC endpoint — no JWT auth required.
 * Called directly from the NNC website contact / service forms.
 *
 * POST /api/website-enquiry
 * Body (JSON or form-encoded):
 *   name        string  required
 *   phone       string  required
 *   email       string  optional
 *   service     string  single service name   (OR)
 *   services    array   multiple service names
 *   requirements / message   string  client's message
 *   branch      string  "Mysore" | "Bangalore" | "Mumbai"  (default: Bangalore)
 */

import express from "express";
import cors    from "cors";
import rateLimit from "express-rate-limit";
import Enquiry   from "../models/Enquiry.js";
import sendEmail from "../utils/sendEmail.js";

const router = express.Router();

/* ── Allow ANY origin so the website can call this freely ──── */
router.use(cors({ origin: "*", methods: ["POST", "OPTIONS"] }));
router.options("/", cors({ origin: "*" }));

/* ── Stricter rate-limit for the public form (20/min per IP) ─ */
const formLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: { success: false, message: "Too many submissions, please try again later." },
});
router.use(formLimiter);

/* ── Service name map: website labels → CRM labels ─────────  */
const SERVICE_MAP = {
  "website development":          "Website Dev",
  "mobile app development":       "Mobile App Dev",
  "crm & custom software":        "Custom Software",
  "crm / software development":   "Custom Software",
  "digital marketing & seo":      "SEO",
  "corporate video production":   "Corporate Ad Film",
  "2d animation":                 "Animation 2D/3D",
  "graphic design & branding":    "Logo & Branding",
  "graphic design":               "Logo & Branding",
  "b2b marketing":                "Social Media Promotions",
  "e-commerce":                   "E-Commerce",
  "ecommerce":                    "E-Commerce",
  "ui/ux design":                 "UI/UX Design",
  "photography/videography":      "Photography/Videography",
  "custom software":              "Custom Software",
  "seo":                          "SEO",
  "google ads":                   "Google Ads",
};

function normalizeService(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().trim();
  return SERVICE_MAP[key] || raw; // fall back to raw if no match
}

/* ── Landing page path → human-readable label ──────────────  */
const LANDING_PAGE_MAP = {
  "/":                                                       "Home Page",
  "/contact-us":                                             "Contact Page",
  "/mobile-app-development-company-in-bangalore":            "Mobile App Dev Page",
  "/web-application-development":                            "Web Application Dev Page",
  "/corporate-website-development":                          "Corporate Website Dev Page",
  "/custom-crm-development":                                 "Custom CRM Dev Page",
  "/ecommerce-website-development-company":                  "E-Commerce Dev Page",
  "/landing-page-development":                               "Landing Page Dev Page",
  "/progressive-web-app-development":                        "Progressive Web App Page",
};

function normalizeLandingPage(pathname) {
  if (!pathname) return "Website";
  const clean = String(pathname).toLowerCase().split("?")[0].replace(/\/$/, "") || "/";
  if (LANDING_PAGE_MAP[clean]) return LANDING_PAGE_MAP[clean];
  // Handle dynamic city pages e.g. /website-development-in-bangalore
  if (clean.includes("mobile-app"))      return "Mobile App Dev Page";
  if (clean.includes("website-develop")) return "Website Dev Page";
  if (clean.includes("digital-market"))  return "Digital Marketing Page";
  if (clean.includes("seo"))             return "SEO Page";
  if (clean.includes("animation"))       return "Animation Page";
  if (clean.includes("graphic"))         return "Graphic Design Page";
  if (clean.includes("video"))           return "Corporate Video Page";
  if (clean.includes("ecommerce"))       return "E-Commerce Dev Page";
  if (clean.includes("crm"))             return "CRM Dev Page";
  return "Website";
}

const VALID_BRANCHES = ["Mysore", "Bangalore", "Mumbai"];

/* ── POST /api/website-enquiry ───────────────────────────────  */
router.post("/", async (req, res) => {
  try {
    const {
      name, phone, email,
      service, services,
      requirements, message,
      branch, landingPage,
      site,
    } = req.body;

    /* Basic validation */
    if (!name?.trim())  return res.status(400).json({ success: false, message: "Name is required" });
    if (!phone?.trim()) return res.status(400).json({ success: false, message: "Phone is required" });

    /* Normalize services list */
    let serviceList = [];
    if (Array.isArray(services)) serviceList = services.map(normalizeService).filter(Boolean);
    else if (service)            serviceList = String(service).split(",").map(s => normalizeService(s.trim())).filter(Boolean);

    const enquiryBranch    = VALID_BRANCHES.includes(branch) ? branch : "Bangalore";
    const requirementsText = (requirements || message || "").trim();
    const pageLabel        = normalizeLandingPage(landingPage);
    const enquirySite      = site === "nncdigital" ? "nncdigital" : "nnc";

    /* Save enquiry to database */
    const enquiry = await Enquiry.create({
      name:         name.trim(),
      phone:        phone.trim(),
      email:        (email || "").trim().toLowerCase(),
      services:     serviceList,
      source:       "Website",
      site:         enquirySite,
      branch:       enquiryBranch,
      requirements: requirementsText,
      landingPage:  pageLabel,
      status:       "new",
      activityLog:  [{
        action: "Enquiry received from website",
        note:   `Site: ${enquirySite === "nncdigital" ? "NNC Digital" : "NNC"} | Page: ${pageLabel} | Services: ${serviceList.join(", ") || "General"} | ${requirementsText.slice(0, 120)}`,
        by:     "Website",
      }],
    });

    /* ── Email to admin (fire-and-forget) ─────────────────── */
    const adminEmail   = process.env.ADMIN_NOTIFY_EMAIL || process.env.EMAIL_USER;
    const frontendUrl  = process.env.FRONTEND_URL || "https://admincrm.nakshatranamahacreations.com";

    if (adminEmail) {
      sendEmail({
        to:      adminEmail,
        subject: `🔔 New Website Enquiry — ${name.trim()} (${serviceList.join(", ") || "General"})`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:580px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:20px 24px">
    <h2 style="margin:0;color:#fff;font-size:18px">New Enquiry from Website</h2>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.7);font-size:12px">${new Date().toLocaleString("en-IN")}</p>
  </div>
  <div style="padding:20px 24px">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;font-weight:700;color:#64748b;width:130px">Name</td><td style="font-weight:700;color:#0f172a">${name.trim()}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;color:#64748b">Phone</td><td><a href="tel:${phone.trim()}" style="color:#2563eb">${phone.trim()}</a></td></tr>
      <tr><td style="padding:8px 0;font-weight:700;color:#64748b">Email</td><td>${email ? `<a href="mailto:${email}" style="color:#2563eb">${email}</a>` : "—"}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;color:#64748b">Services</td><td><strong style="color:#7c3aed">${serviceList.join(", ") || "General Enquiry"}</strong></td></tr>
      <tr><td style="padding:8px 0;font-weight:700;color:#64748b">Branch</td><td>${enquiryBranch}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;color:#64748b;vertical-align:top">Message</td><td style="color:#374151">${requirementsText || "—"}</td></tr>
    </table>
    <div style="margin-top:20px">
      <a href="${frontendUrl}/enquiries" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">View in CRM →</a>
    </div>
  </div>
</div>`,
      }).catch(err => console.error("Admin notify email error:", err));
    }

    /* ── Confirmation email to enquirer ───────────────────── */
    if (email?.trim()) {
      sendEmail({
        to:      email.trim(),
        subject: "We received your enquiry — NNC Nakshatra Namaha Creations",
        html: `
<div style="font-family:Arial,sans-serif;max-width:580px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:20px 24px">
    <h2 style="margin:0;color:#fff;font-size:18px">Thank you for reaching out!</h2>
  </div>
  <div style="padding:20px 24px;font-size:14px;color:#374151;line-height:1.7">
    <p>Hi <strong>${name.trim()}</strong>,</p>
    <p>We've received your enquiry for <strong style="color:#7c3aed">${serviceList.join(", ") || "our services"}</strong>.</p>
    <p>Our team will review your requirements and get back to you within <strong>24 hours</strong>.</p>
    <p style="margin-top:20px;color:#64748b;font-size:12px">
      NNC Nakshatra Namaha Creations<br/>
      📧 info@nakshatranamahacreations.com
    </p>
  </div>
</div>`,
      }).catch(err => console.error("Confirmation email error:", err));
    }

    return res.status(201).json({
      success: true,
      message: "Enquiry received successfully. We will contact you soon!",
      id: enquiry._id,
    });

  } catch (err) {
    console.error("Website enquiry error:", err);
    return res.status(500).json({ success: false, message: "Failed to submit enquiry. Please try again." });
  }
});

export default router;
