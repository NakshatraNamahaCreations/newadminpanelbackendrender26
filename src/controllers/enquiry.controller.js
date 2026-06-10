import mongoose from "mongoose";
import Enquiry from "../models/Enquiry.js";
import sendEmail from "../utils/sendEmail.js";

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Helper: validate that a string is a valid MongoDB ObjectId
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

// Allowed fields for create/update to prevent injection of arbitrary data
const ALLOWED_FIELDS = [
  "name", "phone", "email", "company", "services", "source",
  "budgetMin", "budgetMax", "requirements", "branch", "assignedTo",
  "status", "followUpDate", "landingPage", "gstApplicable", "site",
];

function pickAllowedFields(body) {
  const picked = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in body) picked[key] = body[key];
  }
  return picked;
}

// Source mapping used when converting an enquiry to a lead
const SOURCE_MAP = {
  "Walk-In":    "Call",
  "Phone Call": "Call",
};

// Helper: build date range filter from a named preset
function dateRangeFilter(dateRange) {
  if (!dateRange) return null;
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = now.getMonth();
  const d    = now.getDate();

  if (dateRange === "today") {
    return { $gte: new Date(y, m, d), $lt: new Date(y, m, d + 1) };
  }
  if (dateRange === "week") {
    const day  = now.getDay() || 7;            // Mon=1 … Sun=7
    const mon  = new Date(y, m, d - day + 1);  // start of this Monday
    const sun  = new Date(y, m, d - day + 8);  // start of next Monday
    return { $gte: mon, $lt: sun };
  }
  if (dateRange === "month") {
    return { $gte: new Date(y, m, 1), $lt: new Date(y, m + 1, 1) };
  }
  if (dateRange === "year") {
    return { $gte: new Date(y, 0, 1), $lt: new Date(y + 1, 0, 1) };
  }
  return null;
}

// Helper: build common filter object from query params
function buildFilter(query) {
  const { branch, status, source, service, landingPage, q, dateRange, site } = query;
  const filter = {};

  if (branch)      filter.branch = branch;
  if (status)      filter.status = status;
  if (source)      filter.source = source;
  if (service)     filter.services = service;
  if (landingPage) filter.landingPage = landingPage;
  // Site tab filter. "nnc" must also match legacy enquiries created before the
  // `site` field existed (where site is missing/null) so nothing disappears.
  if (site === "nnc") {
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ site: "nnc" }, { site: { $exists: false } }, { site: null }] },
    ];
  } else if (site) {
    filter.site = site;
  }

  if (q && q.trim()) {
    const regex = new RegExp(escapeRegex(q.trim()), "i");
    filter.$or = [
      { name:    regex },
      { phone:   regex },
      { email:   regex },
      { company: regex },
    ];
  }

  const dr = dateRangeFilter(dateRange);
  if (dr) filter.createdAt = dr;

  return filter;
}

// ---------------------------------------------------------------------------
// GET /api/enquiries
// Query: branch, status, source, service, q, dateRange, page, limit
// ---------------------------------------------------------------------------
export async function getEnquiries(req, res) {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = buildFilter(req.query);

    const skip  = (page - 1) * limit;
    const total = await Enquiry.countDocuments(filter);
    const enquiries = await Enquiry.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.json({ success: true, data: enquiries, total });
  } catch (err) {
    console.error("getEnquiries error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/enquiries/export   → returns CSV file
// Same query params as getEnquiries (no pagination)
// ---------------------------------------------------------------------------
export async function exportEnquiries(req, res) {
  try {
    const filter = buildFilter(req.query);

    const enquiries = await Enquiry.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    // Build CSV
    const escape = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };

    const headers = [
      "Name", "Phone", "Email", "Company", "Services",
      "Source", "Branch", "Assigned To", "Status",
      "Budget Min", "Budget Max", "Follow-up Date",
      "Converted", "Requirements", "Created At",
    ];

    const rows = enquiries.map(e => [
      escape(e.name),
      escape(e.phone),
      escape(e.email),
      escape(e.company),
      escape((e.services || []).join("; ")),
      escape(e.source),
      escape(e.branch),
      escape(e.assignedTo),
      escape(e.status),
      escape(e.budgetMin || 0),
      escape(e.budgetMax || 0),
      escape(e.followUpDate ? new Date(e.followUpDate).toISOString().split("T")[0] : ""),
      escape(e.convertedToLead ? "Yes" : "No"),
      escape(e.requirements),
      escape(e.createdAt ? new Date(e.createdAt).toISOString().split("T")[0] : ""),
    ]);

    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="enquiries-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error("exportEnquiries error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/enquiries/stats
// Query: branch
// ---------------------------------------------------------------------------
export async function getEnquiryStats(req, res) {
  try {
    const { branch, site } = req.query;
    const matchStage = {};
    if (branch) matchStage.branch = branch;
    if (site === "nnc") {
      matchStage.$or = [{ site: "nnc" }, { site: { $exists: false } }, { site: null }];
    } else if (site) {
      matchStage.site = site;
    }

    const now        = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const todayStart   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd     = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const [agg] = await Enquiry.aggregate([
      { $match: matchStage },
      {
        $facet: {
          total: [{ $count: "count" }],
          byStatus: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
          byService: [
            { $unwind: { path: "$services", preserveNullAndEmptyArrays: false } },
            { $group: { _id: "$services", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          newThisMonth: [
            { $match: { createdAt: { $gte: startOfMonth } } },
            { $count: "count" },
          ],
          todayFollowUps: [
            {
              $match: {
                followUpDate: { $gte: todayStart, $lt: todayEnd },
                status: { $nin: ["won", "lost"] },
              },
            },
            { $count: "count" },
          ],
        },
      },
    ]);

    const total = agg.total[0]?.count || 0;

    // Build byStatus map
    const byStatusRaw = agg.byStatus || [];
    const byStatus = {
      new:        0,
      contacted:  0,
      "follow-up": 0,
      quoted:     0,
      won:        0,
      lost:       0,
    };
    for (const s of byStatusRaw) {
      if (s._id in byStatus) byStatus[s._id] = s.count;
    }

    const conversionRate = total > 0 ? Math.round((byStatus.won / total) * 10000) / 100 : 0;

    const byService = (agg.byService || []).map((s) => ({
      service: s._id,
      count:   s.count,
    }));

    return res.json({
      success: true,
      data: {
        total,
        byStatus,
        conversionRate,
        byService,
        newThisMonth:   agg.newThisMonth[0]?.count    || 0,
        todayFollowUps: agg.todayFollowUps[0]?.count  || 0,
      },
    });
  } catch (err) {
    console.error("getEnquiryStats error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/enquiries/:id
// ---------------------------------------------------------------------------
export async function getEnquiryById(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry ID" });
    }
    const enquiry = await Enquiry.findById(req.params.id).lean();
    if (!enquiry) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }
    return res.json({ success: true, data: enquiry });
  } catch (err) {
    console.error("getEnquiryById error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// POST /api/enquiries
// ---------------------------------------------------------------------------
export async function createEnquiry(req, res) {
  try {
    const { name, phone, branch, createdBy } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }
    const phoneTrimmed = String(phone).trim();
    if (!/^\+?[\d\s\-()]{7,15}$/.test(phoneTrimmed)) {
      return res.status(400).json({ success: false, message: "Invalid phone number format" });
    }
    if (!branch) {
      return res.status(400).json({ success: false, message: "branch is required" });
    }
    if (req.body.email && req.body.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    const safe = pickAllowedFields(req.body);

    const enquiry = await Enquiry.create({
      ...safe,
      name:   String(name).trim(),
      phone:  phoneTrimmed,
      branch,
      activityLog: [
        {
          action: "Created",
          note:   "Enquiry created",
          by:     createdBy || "Admin",
          at:     new Date(),
        },
      ],
    });

    // Send thank-you email to enquiry contact (fire-and-forget)
    if (enquiry.email) {
      const servicesList = (enquiry.services || []).join(", ") || "your requirements";
      const requirementsText = enquiry.requirements
        ? `<p style="margin:0 0 12px">Based on our conversation, here's what we noted:</p>
           <div style="background:#f0f7ff;border-left:3px solid #2563eb;padding:12px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#1e3a8a;line-height:1.7">${enquiry.requirements.replace(/\n/g, "<br/>")}</div>`
        : "";

      sendEmail({
        to: enquiry.email,
        subject: `Thank you for reaching out, ${enquiry.name} — NNC`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:580px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:24px 28px">
    <h2 style="margin:0;color:#fff;font-size:20px">Thank you for reaching out!</h2>
    <p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:13px">NNC Nakshatra Namaha Creations</p>
  </div>
  <div style="padding:24px 28px;font-size:14px;color:#374151;line-height:1.7">
    <p style="margin:0 0 16px">Hi <strong>${enquiry.name}</strong>,</p>
    <p style="margin:0 0 16px">Thank you for taking the time to speak with us. We truly appreciate your interest in <strong style="color:#7c3aed">${servicesList}</strong>.</p>
    ${requirementsText}
    <p style="margin:16px 0 0">Our team will review everything and get back to you with a detailed proposal shortly. If you have any questions in the meantime, feel free to reply to this email or call us.</p>
    <div style="margin:28px 0 8px;text-align:center">
      <a href="tel:+919900566466" style="display:inline-block;background:#2563eb;color:#fff;padding:11px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">📞 Call +91 99005 66466</a>
    </div>
    <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8">
      NNC Nakshatra Namaha Creations Pvt. Ltd.<br/>
      Bengaluru · Mysuru · Mumbai<br/>
      <a href="https://www.nakshatranamahacreations.com" style="color:#2563eb;text-decoration:none">nakshatranamahacreations.com</a>
    </p>
  </div>
</div>`,
      }).catch((err) => console.error("Enquiry thank-you email error:", err));
    }

    return res.status(201).json({ success: true, data: enquiry });
  } catch (err) {
    console.error("createEnquiry error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/enquiries/:id
// ---------------------------------------------------------------------------
export async function updateEnquiry(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry ID" });
    }

    // Validate name/phone are not being set to empty
    if ("name" in req.body && (!req.body.name || !String(req.body.name).trim())) {
      return res.status(400).json({ success: false, message: "name cannot be empty" });
    }
    if ("phone" in req.body && (!req.body.phone || !String(req.body.phone).trim())) {
      return res.status(400).json({ success: false, message: "phone cannot be empty" });
    }
    if ("phone" in req.body && !/^\+?[\d\s\-()]{7,15}$/.test(String(req.body.phone).trim())) {
      return res.status(400).json({ success: false, message: "Invalid phone number format" });
    }
    if ("email" in req.body && req.body.email && req.body.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    const existing = await Enquiry.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }

    const updates    = pickAllowedFields(req.body);
    const newLogEntries = [];
    const updatedBy  = req.body.updatedBy || "Admin";

    // Track status change
    if (updates.status && updates.status !== existing.status) {
      newLogEntries.push({
        action: "Status Changed",
        note:   `Status changed to ${updates.status}`,
        by:     updatedBy,
        at:     new Date(),
      });
    }

    // Track followUpDate change
    if (updates.followUpDate !== undefined) {
      const newDate    = updates.followUpDate ? new Date(updates.followUpDate) : null;
      const existingDate = existing.followUpDate;
      const changed    = String(newDate) !== String(existingDate);
      if (changed && newDate) {
        newLogEntries.push({
          action: "Follow-up Scheduled",
          note:   `Follow-up scheduled for ${newDate.toDateString()}`,
          by:     updatedBy,
          at:     new Date(),
        });
      }
    }

    const updated = await Enquiry.findByIdAndUpdate(
      req.params.id,
      {
        $set:  updates,
        ...(newLogEntries.length > 0 ? { $push: { activityLog: { $each: newLogEntries } } } : {}),
      },
      { new: true, runValidators: true }
    );

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("updateEnquiry error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/enquiries/:id
// ---------------------------------------------------------------------------
export async function deleteEnquiry(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry ID" });
    }
    const enquiry = await Enquiry.findById(req.params.id);
    if (!enquiry) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }
    if (enquiry.convertedToLead === true) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete an enquiry that has already been converted to a lead",
      });
    }
    await Enquiry.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Enquiry deleted successfully" });
  } catch (err) {
    console.error("deleteEnquiry error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// POST /api/enquiries/:id/activity
// Body: { action, note, by }
// ---------------------------------------------------------------------------
export async function addActivity(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry ID" });
    }

    const { action, note, by } = req.body;
    if (!note || !String(note).trim()) {
      return res.status(400).json({ success: false, message: "Activity note is required" });
    }

    const enquiry = await Enquiry.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          activityLog: {
            action: action || "Note",
            note:   note   || "",
            by:     by     || "Admin",
            at:     new Date(),
          },
        },
      },
      { new: true }
    );

    if (!enquiry) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }

    return res.json({ success: true, data: enquiry });
  } catch (err) {
    console.error("addActivity error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// POST /api/enquiries/:id/convert
// ---------------------------------------------------------------------------
export async function convertToLead(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry ID" });
    }
    const enquiry = await Enquiry.findById(req.params.id);
    if (!enquiry) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }
    if (enquiry.convertedToLead === true) {
      return res.status(400).json({
        success: false,
        message: "Enquiry has already been converted to a lead",
      });
    }

    // Dynamic import to avoid circular dependency issues
    const { default: Lead } = await import("../models/Lead.js");

    // Map enquiry source to lead source values
    const mappedSource = SOURCE_MAP[enquiry.source] || enquiry.source;

    const lead = await Lead.create({
      name:         enquiry.name,
      phone:        enquiry.phone,
      email:        enquiry.email,
      business:     enquiry.company,
      company:      enquiry.company,
      requirements: enquiry.requirements,
      branch:       enquiry.branch,
      source:       mappedSource,
      rep:          enquiry.assignedTo,
      value:        enquiry.budgetMax,
      stage:        "Lead Capture",
      status:       "new",
      priority:     "Hot",
      industry:     (enquiry.services || []).join(", "),
    });

    // Update enquiry as converted
    enquiry.convertedToLead  = true;
    enquiry.convertedLeadId  = lead._id;
    enquiry.convertedAt      = new Date();
    enquiry.activityLog.push({
      action: "Converted",
      note:   "Converted to Lead",
      by:     req.body?.convertedBy || "Admin",
      at:     new Date(),
    });
    await enquiry.save();

    return res.json({ success: true, data: { enquiry, lead } });
  } catch (err) {
    console.error("convertToLead error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}
