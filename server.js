import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import compression from "compression";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import leadRoutes from "./src/routes/lead.routes.js";
import repRoutes from "./src/routes/rep.routes.js";
import documentRoutes from "./src/routes/document.routes.js";
import authRoutes from "./src/routes/auth.routes.js";
import analyticsRoutes from "./src/routes/analytics.routes.js";
import leaderboardRoutes from "./src/routes/leaderboard.routes.js";
import branchReportsRoutes from "./src/routes/branchReports.routes.js";
import dashboardRoutes from "./src/routes/dashboard.routes.js";
import paymentTrackerRoutes from "./src/routes/paymentTrackerRoutes.js";
import masterAdminRoutes from "./src/routes/masterAdmin.routes.js";
import todayPlanRoutes from "./src/routes/todayPlan.routes.js";
import userRoutes from "./src/routes/user.routes.js";
import calendarEventRoutes from "./src/routes/calendarEvent.routes.js";
import expenseRoutes from "./src/routes/expense.routes.js";
import pnlRoutes     from "./src/routes/pnl.routes.js";
import invoiceRoutes     from "./src/routes/invoice.routes.js";
import gstRoutes         from "./src/routes/gst.routes.js";
import gstReportRoutes   from "./src/routes/gstReport.routes.js";
import enquiryRoutes     from "./src/routes/enquiry.routes.js";
import attendanceRoutes  from "./src/routes/attendance.routes.js";
import biRoutes              from "./src/routes/bi.routes.js";
import quotationRoutes       from "./src/routes/quotation.routes.js";
import proformaInvoiceRoutes from "./src/routes/proformaInvoice.routes.js";
import websiteEnquiryRoutes from "./src/routes/websiteEnquiry.routes.js";
import ownerDeskRoutes from "./src/routes/ownerDesk.routes.js";
import credentialRoutes from "./src/routes/credential.routes.js";
import { initReportScheduler } from "./src/services/reportScheduler.js";
import { getDashboardSummary } from "./src/services/dashboard.service.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsPath = path.join(__dirname, "uploads");
const docsUploadsPath = path.join(__dirname, "uploads", "docs");

try {
  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
  }

  if (!fs.existsSync(docsUploadsPath)) {
    fs.mkdirSync(docsUploadsPath, { recursive: true });
  }
} catch (error) {
  console.error("Upload folder creation error:", error);
}

/* ─── Security headers ─────────────────────────────────────── */
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

/* ─── Gzip compression (60-80% bandwidth reduction) ────────── */
app.use(compression({ level: 6, threshold: 1024 }));

/* ─── CORS ─────────────────────────────────────────────────── */
const allowedOrigins = [
  "https://admincrm.nakshatranamahacreations.com",
  "https://nakshatranamahacreations.com",
  "https://www.nakshatranamahacreations.com",
];
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS not allowed: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};
app.use(cors(corsOptions));
// Handle preflight for all routes
app.options("/{*splat}", cors(corsOptions));

/* ─── Rate limiting (prevents abuse, allows 20+ concurrent users) */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1-minute window
  max: 300,                  // 300 requests per minute per IP (15 req/s)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later." },
  skip: (req) => req.method === "OPTIONS",
});
app.use("/api", apiLimiter);

/* ─── Body parsing ─────────────────────────────────────────── */
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "NNC CRM Backend is running",
  });
});

app.use("/uploads", express.static(uploadsPath));

/* ── Public website webhook (no auth, open CORS) ───────────── */
app.use("/api/website-enquiry", websiteEnquiryRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/reps", repRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/branch-reports", branchReportsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/payment-tracker", paymentTrackerRoutes);
app.use("/api/master-admin", masterAdminRoutes);
app.use("/api/today-plan", todayPlanRoutes);
app.use("/api/users", userRoutes);
app.use("/api/calendar-events", calendarEventRoutes);
app.use("/api/expenses",        expenseRoutes);
app.use("/api/pnl",            pnlRoutes);
app.use("/api/invoices",       invoiceRoutes);
app.use("/api/gst-lookup",    gstRoutes);
app.use("/api/gst-report",    gstReportRoutes);
app.use("/api/enquiries",     enquiryRoutes);
app.use("/api/attendance",    attendanceRoutes);
app.use("/api/bi",            biRoutes);
app.use("/api/quotations",        quotationRoutes);
app.use("/api/proforma-invoices", proformaInvoiceRoutes);
app.use("/api/owner-desk",       ownerDeskRoutes);
app.use("/api/credentials",      credentialRoutes);



app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
    method: req.method,
  });
});

app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  if (err.name === "MulterError") {
    return res.status(400).json({
      success: false,
      message: err.message || "File upload error",
    });
  }

  return res.status(500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI missing in .env");
    }

    await mongoose.connect(process.env.MONGO_URI, {
      autoIndex:                  true,  // builds new indexes on startup
      maxPoolSize:                20,    // max concurrent connections
      minPoolSize:                5,     // keep 5 connections warm
      serverSelectionTimeoutMS:   5_000,
      socketTimeoutMS:            45_000,
      connectTimeoutMS:           10_000,
    });

    console.log("MongoDB connected successfully");

    initReportScheduler();

    // Pre-warm dashboard cache so the first morning request is instant
    getDashboardSummary()
      .then(() => console.log("Dashboard cache warmed up"))
      .catch((err) => console.warn("Dashboard warm-up failed (non-fatal):", err.message));

    app.listen(PORT, () => {
      console.log(`API running at http://localhost:${PORT}`);
      console.log(`Uploads served at http://localhost:${PORT}/uploads`);
      console.log(`Docs served at http://localhost:${PORT}/uploads/docs`);
    });
  } catch (err) {
    console.error("MongoDB connect error:", err.message || err);
    process.exit(1);
  }
}

startServer();