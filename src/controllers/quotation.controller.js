import Quotation      from "../models/Quotation.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import Enquiry         from "../models/Enquiry.js";
import sendEmail       from "../utils/sendEmail.js";

const BRANCHES = ["Bangalore", "Mysore", "Mumbai"];

function calcTotals(lineItems = [], discount = 0, taxPct = 0) {
  const subtotal = lineItems.reduce((s, item) => s + Number(item.amount || 0), 0);
  const taxAmt   = ((subtotal - discount) * taxPct) / 100;
  const total    = Math.max(0, subtotal - discount + taxAmt);
  return { subtotal, total };
}

// GET /api/quotations
export async function getQuotations(req, res) {
  try {
    const { branch, status, q, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (branch) filter.branch = branch;
    if (status) filter.status = status;
    if (q?.trim()) {
      // escape special regex chars to avoid ReDoS and slow scans
      const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(escaped, "i");
      filter.$or = [
        { clientName:    rx },
        { clientPhone:   rx },
        { clientCompany: rx },
        { quoteNumber:   rx },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const lim  = Math.min(Number(limit), 50);

    // single round-trip: count + data in one aggregation
    const [result] = await Quotation.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $facet: {
          data:  [{ $skip: skip }, { $limit: lim }],
          total: [{ $count: "count" }],
      }},
    ]);

    return res.json({
      success: true,
      data:  result.data  || [],
      total: result.total[0]?.count || 0,
    });
  } catch (err) {
    console.error("getQuotations error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// GET /api/quotations/stats
export async function getQuotationStats(req, res) {
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [agg] = await Quotation.aggregate([
      {
        $facet: {
          total:      [{ $count: "count" }],
          byStatus:   [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          thisMonth:  [{ $match: { createdAt: { $gte: monthStart } } }, { $count: "count" }],
          totalValue: [{ $match: { status: { $in: ["approved", "final", "converted"] } } }, { $group: { _id: null, sum: { $sum: "$total" } } }],
        },
      },
    ]);

    const byStatus = { draft: 0, sent: 0, under_negotiation: 0, approved: 0, rejected: 0, final: 0, converted: 0, expired: 0 };
    for (const s of agg.byStatus || []) {
      if (s._id in byStatus) byStatus[s._id] = s.count;
    }
    const totalCount     = agg.total[0]?.count || 0;
    const wonCount       = (byStatus.approved + byStatus.final + byStatus.converted);
    const conversionRate = totalCount > 0 ? Math.round((wonCount / totalCount) * 100) : 0;

    return res.json({
      success: true,
      data: {
        total:          totalCount,
        byStatus,
        thisMonth:      agg.thisMonth[0]?.count || 0,
        acceptedValue:  agg.totalValue[0]?.sum  || 0,
        conversionRate,
      },
    });
  } catch (err) {
    console.error("getQuotationStats error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// GET /api/quotations/:id
export async function getQuotationById(req, res) {
  try {
    const q = await Quotation.findById(req.params.id).lean();
    if (!q) return res.status(404).json({ success: false, message: "Quotation not found" });
    return res.json({ success: true, data: q });
  } catch (err) {
    console.error("getQuotationById error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// POST /api/quotations
export async function createQuotation(req, res) {
  try {
    const {
      clientName, clientPhone, clientEmail, clientCompany,
      clientAddress, clientGstin,
      enquiryId, branch, services, lineItems,
      discount = 0, tax = 0, validUntil, notes, terms, createdBy, senderEmail,
      serviceCategory,
    } = req.body;

    if (!clientName?.trim()) return res.status(400).json({ success: false, message: "Client name is required" });
    if (!branch || !BRANCHES.includes(branch)) return res.status(400).json({ success: false, message: "Valid branch is required" });

    const safeItems = (lineItems || [])
      .filter(item => String(item.description || "").trim() || Number(item.rate || 0) > 0)
      .map(item => ({
        description: String(item.description || "").trim(),
        qty:    Number(item.qty  || 1),
        rate:   Number(item.rate || 0),
        amount: Number(item.qty  || 1) * Number(item.rate || 0),
      }));

    const { subtotal, total } = calcTotals(safeItems, Number(discount), Number(tax));

    const quotation = await Quotation.create({
      clientName:    clientName.trim(),
      clientPhone:   clientPhone   || "",
      clientEmail:   clientEmail   || "",
      clientCompany: clientCompany || "",
      clientAddress: clientAddress || "",
      clientGstin:   clientGstin   || "",
      enquiryId:     enquiryId     || null,
      branch,
      services:  services  || [],
      lineItems: safeItems,
      subtotal,
      discount:  Number(discount),
      tax:       Number(tax),
      total,
      validUntil: validUntil || null,
      serviceCategory: serviceCategory || "",
      notes:      notes  || "",
      terms:      terms  || "",
      senderEmail: senderEmail || "",
      createdBy:   createdBy || "Admin",
      status:      "draft",
    });

    // If linked to enquiry, update enquiry status to "quoted"
    if (enquiryId) {
      await Enquiry.findByIdAndUpdate(enquiryId, { status: "quoted" }).catch(() => {});
    }

    return res.status(201).json({ success: true, data: quotation });
  } catch (err) {
    console.error("createQuotation error:", err);
    if (err.name === "ValidationError") return res.status(400).json({ success: false, message: err.message });
    if (err.code === 11000) return res.status(409).json({ success: false, message: "Quote number conflict — please try again." });
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// PUT /api/quotations/:id
export async function updateQuotation(req, res) {
  try {
    const existing = await Quotation.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Quotation not found" });

    const {
      clientName, clientPhone, clientEmail, clientCompany,
      clientAddress, clientGstin,
      branch, services, lineItems,
      discount, tax, validUntil, notes, terms, status,
    } = req.body;

    const { senderEmail } = req.body;
    if (senderEmail   !== undefined) existing.senderEmail   = senderEmail;
    if (clientName    !== undefined) existing.clientName    = clientName.trim();
    if (clientPhone   !== undefined) existing.clientPhone   = clientPhone;
    if (clientEmail   !== undefined) existing.clientEmail   = clientEmail;
    if (clientCompany !== undefined) existing.clientCompany = clientCompany;
    if (clientAddress !== undefined) existing.clientAddress = clientAddress;
    if (clientGstin   !== undefined) existing.clientGstin   = clientGstin;
    if (branch !== undefined && BRANCHES.includes(branch)) existing.branch = branch;
    if (services  !== undefined) existing.services  = services;
    if (validUntil !== undefined) existing.validUntil = validUntil || null;
    if (notes  !== undefined) existing.notes  = notes;
    if (terms  !== undefined) existing.terms  = terms;
    const { serviceCategory } = req.body;
    if (serviceCategory !== undefined) existing.serviceCategory = serviceCategory;

    if (status !== undefined) {
      existing.status = status;
      if (status === "sent"               && !existing.sentAt)      existing.sentAt      = new Date();
      if (status === "approved"           && !existing.approvedAt)  existing.approvedAt  = new Date();
      if (status === "rejected"           && !existing.rejectedAt)  existing.rejectedAt  = new Date();
    }

    if (lineItems !== undefined) {
      existing.lineItems = (lineItems || [])
        .filter(item => String(item.description || "").trim() || Number(item.rate || 0) > 0)
        .map(item => ({
          description: String(item.description || "").trim(),
          qty:    Number(item.qty  || 1),
          rate:   Number(item.rate || 0),
          amount: Number(item.qty  || 1) * Number(item.rate || 0),
        }));
    }
    if (discount !== undefined) existing.discount = Number(discount);
    if (tax      !== undefined) existing.tax      = Number(tax);

    const { subtotal, total } = calcTotals(existing.lineItems, existing.discount, existing.tax);
    existing.subtotal = subtotal;
    existing.total    = total;

    await existing.save();
    return res.json({ success: true, data: existing });
  } catch (err) {
    console.error("updateQuotation error:", err);
    if (err.name === "ValidationError") return res.status(400).json({ success: false, message: err.message });
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// PATCH /api/quotations/:id/status
export async function updateStatus(req, res) {
  try {
    const { status } = req.body;
    const VALID = ["draft", "sent", "under_negotiation", "approved", "rejected", "final", "converted", "expired"];
    if (!VALID.includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });

    const q = await Quotation.findById(req.params.id);
    if (!q) return res.status(404).json({ success: false, message: "Quotation not found" });

    q.status = status;
    if (status === "sent"     && !q.sentAt)     q.sentAt     = new Date();
    if (status === "approved" && !q.approvedAt) q.approvedAt = new Date();
    if (status === "rejected" && !q.rejectedAt) q.rejectedAt = new Date();

    // Auto-add system note
    q.negotiationHistory.push({ note: `Status changed to "${status}"`, by: req.user?.name || "Admin", type: "system", at: new Date() });

    await q.save();
    return res.json({ success: true, data: q });
  } catch (err) {
    console.error("updateStatus error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// POST /api/quotations/:id/negotiate  — add a negotiation note
export async function addNegotiationNote(req, res) {
  try {
    const { note, by } = req.body;
    if (!note?.trim()) return res.status(400).json({ success: false, message: "Note is required" });

    const q = await Quotation.findById(req.params.id);
    if (!q) return res.status(404).json({ success: false, message: "Quotation not found" });

    q.negotiationHistory.push({ note: note.trim(), by: by || req.user?.name || "Admin", type: "admin", at: new Date() });
    if (q.status === "sent") q.status = "under_negotiation";

    await q.save();
    return res.json({ success: true, data: q });
  } catch (err) {
    console.error("addNegotiationNote error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// POST /api/quotations/:id/revise  — create a new revision
export async function createRevision(req, res) {
  try {
    const original = await Quotation.findById(req.params.id).lean();
    if (!original) return res.status(404).json({ success: false, message: "Quotation not found" });

    const { lineItems, discount, tax, validUntil, notes, terms, clientAddress, clientGstin } = req.body;

    // Determine revision number
    const latestRevision = await Quotation.findOne({ parentQuoteId: original._id }).sort({ revisionNumber: -1 }).lean();
    const revisionNumber = latestRevision ? latestRevision.revisionNumber + 1 : 2;

    const safeItems = (lineItems || original.lineItems).map(item => ({
      description: String(item.description || "").trim(),
      qty:    Number(item.qty  || 1),
      rate:   Number(item.rate || 0),
      amount: Number(item.qty  || 1) * Number(item.rate || 0),
    }));

    const discountVal = discount !== undefined ? Number(discount) : original.discount;
    const taxVal      = tax      !== undefined ? Number(tax)      : original.tax;
    const { subtotal, total } = calcTotals(safeItems, discountVal, taxVal);

    const revision = await Quotation.create({
      clientName:    original.clientName,
      clientPhone:   original.clientPhone,
      clientEmail:   original.clientEmail,
      clientCompany: original.clientCompany,
      clientAddress: clientAddress !== undefined ? clientAddress : original.clientAddress,
      clientGstin:   clientGstin   !== undefined ? clientGstin   : original.clientGstin,
      enquiryId:     original.enquiryId,
      branch:        original.branch,
      services:      original.services,
      lineItems:     safeItems,
      subtotal,
      discount:      discountVal,
      tax:           taxVal,
      total,
      validUntil:    validUntil !== undefined ? validUntil || null : original.validUntil,
      notes:         notes !== undefined ? notes : original.notes,
      terms:         terms !== undefined ? terms : original.terms,
      createdBy:     req.user?.name || "Admin",
      status:        "draft",
      isRevision:    true,
      revisionNumber,
      parentQuoteId: original._id,
      negotiationHistory: [{
        note: `Revision ${revisionNumber} created from ${original.quoteNumber}`,
        by:   req.user?.name || "Admin",
        type: "system",
        at:   new Date(),
      }],
    });

    return res.status(201).json({ success: true, data: revision });
  } catch (err) {
    console.error("createRevision error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// POST /api/quotations/:id/convert-to-proforma
export async function convertToProforma(req, res) {
  try {
    const q = await Quotation.findById(req.params.id);
    if (!q) return res.status(404).json({ success: false, message: "Quotation not found" });
    if (!["approved", "final"].includes(q.status)) {
      return res.status(400).json({ success: false, message: "Quotation must be approved or final to convert" });
    }
    if (q.proformaId) {
      return res.status(400).json({ success: false, message: "Already converted to proforma", proformaId: q.proformaId });
    }

    const { deliveryDate, paymentTerms } = req.body;

    const proforma = await ProformaInvoice.create({
      quotationId:   q._id,
      quoteNumber:   q.quoteNumber,
      clientName:    q.clientName,
      clientPhone:   q.clientPhone,
      clientEmail:   q.clientEmail,
      clientCompany: q.clientCompany,
      clientAddress: q.clientAddress,
      clientGstin:   q.clientGstin,
      enquiryId:     q.enquiryId,
      branch:        q.branch,
      lineItems:     q.lineItems,
      subtotal:      q.subtotal,
      discount:      q.discount,
      tax:           q.tax,
      total:         q.total,
      notes:         q.notes,
      terms:         q.terms,
      deliveryDate:  deliveryDate || null,
      paymentTerms:  paymentTerms || "",
      createdBy:     req.user?.name || "Admin",
      status:        "draft",
    });

    q.status      = "converted";
    q.proformaId  = proforma._id;
    q.convertedAt = new Date();
    q.negotiationHistory.push({ note: `Converted to Proforma Invoice ${proforma.proformaNumber}`, by: req.user?.name || "Admin", type: "system", at: new Date() });
    await q.save();

    return res.status(201).json({ success: true, data: proforma });
  } catch (err) {
    console.error("convertToProforma error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// POST /api/quotations/:id/send
export async function sendQuotationEmail(req, res) {
  try {
    const q = await Quotation.findById(req.params.id).lean();
    if (!q) return res.status(404).json({ success: false, message: "Quotation not found" });
    if (!q.clientEmail) return res.status(400).json({ success: false, message: "Client email is not set" });

    const itemRows = (q.lineItems || [])
      .map((item, i) => `
        <tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"}">
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#374151">${item.description}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#374151;text-align:center">${item.qty}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#374151;text-align:right">₹${Number(item.rate || 0).toLocaleString("en-IN")}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#0f172a;text-align:right">₹${Number(item.amount || 0).toLocaleString("en-IN")}</td>
        </tr>`)
      .join("");

    const validUntilText = q.validUntil
      ? `<p style="margin:0 0 4px;font-size:13px;color:#64748b">Valid Until: <strong style="color:#0f172a">${new Date(q.validUntil).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</strong></p>`
      : "";

    const gstLine = q.tax > 0
      ? `<tr><td style="padding:6px 14px;font-size:13px;color:#64748b;text-align:right">GST (${q.tax}%)</td><td style="padding:6px 14px;font-size:13px;text-align:right;width:130px">₹${(((q.subtotal - q.discount) * q.tax) / 100).toLocaleString("en-IN")}</td></tr>`
      : "";
    const discountLine = q.discount > 0
      ? `<tr><td style="padding:6px 14px;font-size:13px;color:#16a34a;text-align:right">Discount</td><td style="padding:6px 14px;font-size:13px;color:#16a34a;text-align:right">− ₹${Number(q.discount).toLocaleString("en-IN")}</td></tr>`
      : "";

    const branchInfo = {
      Bangalore: { addr: "No. 45, 2nd Floor, HSR Layout, Bengaluru – 560102", phone: "+91 99005 66466" },
      Mysore:    { addr: "Saraswathipuram, Mysuru – 570009",                   phone: "+91 99005 66466" },
      Mumbai:    { addr: "Andheri East, Mumbai – 400069",                      phone: "+91 99005 66466" },
    };
    const bi = branchInfo[q.branch] || branchInfo.Bangalore;

    const firstName  = String(q.clientName || "").trim().split(/\s+/)[0] || "there";
    const greetingName = q.clientName ? q.clientName : "Valued Client";
    const validUntilSentence = q.validUntil
      ? ` This proposal is valid until <strong>${new Date(q.validUntil).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</strong>.`
      : "";

    const html = `
<div style="font-family:Arial,sans-serif;max-width:660px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);padding:28px 32px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">NNC</div>
          <div style="font-size:11px;color:rgba(255,255,255,.6);margin-top:2px">Nakshatra Namaha Creations</div>
        </td>
        <td style="text-align:right">
          <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:1.5px">Quotation</div>
          <div style="font-size:20px;font-weight:900;color:#7c3aed;font-family:monospace;margin-top:3px">${q.quoteNumber}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.45);margin-top:2px">Branch: ${q.branch}</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Professional Cover Note -->
  <div style="padding:28px 32px 8px;background:#ffffff">
    <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:12px">
      Dear ${greetingName},
    </div>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.75;color:#334155">
      Thank you for considering <strong style="color:#0f172a">Nakshatra Namaha Creations</strong> for your project${q.clientCompany ? ` at <strong style="color:#0f172a">${q.clientCompany}</strong>` : ""}. We truly appreciate the opportunity to be of service.
    </p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.75;color:#334155">
      Please find enclosed our formal quotation <strong style="color:#7c3aed">${q.quoteNumber}</strong>, prepared with careful attention to your requirements. The details below outline the scope of work, deliverables, and the corresponding investment.${validUntilSentence}
    </p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#334155">
      Should you have any questions, require clarifications, or wish to discuss any aspect further, we would be delighted to assist. We look forward to the privilege of partnering with you and delivering a result that exceeds your expectations.
    </p>
  </div>

  <!-- Bill To + Meta -->
  <div style="background:#f8fafc;padding:20px 32px;border-bottom:1px solid #e2e8f0">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:top;width:55%">
          <div style="font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Bill To</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a">${q.clientName}</div>
          ${q.clientCompany ? `<div style="font-size:13px;color:#475569;margin-top:2px">${q.clientCompany}</div>` : ""}
          ${q.clientAddress ? `<div style="font-size:12px;color:#64748b;margin-top:4px">${q.clientAddress}</div>` : ""}
          ${q.clientPhone   ? `<div style="font-size:12px;color:#64748b;margin-top:4px">📞 ${q.clientPhone}</div>` : ""}
          ${q.clientEmail   ? `<div style="font-size:12px;color:#64748b;margin-top:2px">✉ ${q.clientEmail}</div>` : ""}
          ${q.clientGstin   ? `<div style="font-size:12px;color:#64748b;margin-top:4px">GSTIN: ${q.clientGstin}</div>` : ""}
        </td>
        <td style="vertical-align:top;text-align:right">
          <div style="font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Details</div>
          <div style="font-size:12px;color:#64748b;margin-bottom:4px">Date: <strong style="color:#0f172a">${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</strong></div>
          ${validUntilText}
          ${q.revisionNumber > 1 ? `<div style="font-size:12px;color:#7c3aed">Revision ${q.revisionNumber}</div>` : ""}
        </td>
      </tr>
    </table>
  </div>

  <!-- Items Table -->
  <div style="padding:0 32px 24px">
    <table style="width:100%;border-collapse:collapse;margin-top:20px">
      <thead>
        <tr style="background:#0f172a">
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.5px">Description</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.5px;width:60px">Qty</th>
          <th style="padding:10px 14px;text-align:right;font-size:11px;font-weight:700;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.5px;width:110px">Rate</th>
          <th style="padding:10px 14px;text-align:right;font-size:11px;font-weight:700;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.5px;width:120px">Amount</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <!-- Totals -->
    <table style="width:100%;margin-top:4px;border-top:2px solid #e2e8f0">
      <tr><td style="padding:6px 14px;font-size:13px;color:#64748b;text-align:right">Subtotal</td><td style="padding:6px 14px;font-size:13px;text-align:right;width:130px">₹${Number(q.subtotal || 0).toLocaleString("en-IN")}</td></tr>
      ${discountLine}
      ${gstLine}
      <tr style="background:#f1f5f9">
        <td style="padding:12px 14px;font-size:16px;font-weight:900;color:#0f172a;text-align:right">Total</td>
        <td style="padding:12px 14px;font-size:16px;font-weight:900;color:#7c3aed;text-align:right">₹${Number(q.total || 0).toLocaleString("en-IN")}</td>
      </tr>
    </table>
  </div>

  ${q.notes ? `<div style="margin:0 32px 16px;background:#f8fafc;border-radius:8px;padding:14px 16px;font-size:13px;color:#475569;border-left:3px solid #7c3aed"><strong>Notes:</strong><br/><span style="line-height:1.7">${q.notes.replace(/\n/g, "<br/>")}</span></div>` : ""}
  ${q.terms ? `<div style="margin:0 32px 24px;background:#fefce8;border-radius:8px;padding:14px 16px;font-size:12px;color:#713f12;border-left:3px solid #eab308"><strong>Terms & Conditions:</strong><br/><span style="line-height:1.7">${q.terms.replace(/\n/g, "<br/>")}</span></div>` : ""}

  <!-- Closing signature -->
  <div style="padding:8px 32px 26px;background:#ffffff">
    <p style="margin:0 0 12px;font-size:14px;line-height:1.75;color:#334155">
      We thank you once again for the opportunity and look forward to your kind confirmation. Please feel free to reach out to us${q.senderEmail ? ` directly at <a href="mailto:${q.senderEmail}" style="color:#7c3aed;text-decoration:none;font-weight:600">${q.senderEmail}</a>` : ""} for any assistance.
    </p>
    <div style="margin-top:14px;font-size:14px;color:#0f172a">
      <div style="font-weight:700">Warm regards,</div>
      <div style="font-weight:800;margin-top:4px">Team Nakshatra Namaha Creations Pvt. Ltd.</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px">Website &amp; Digital Solutions &nbsp;•&nbsp; ${q.branch} Office</div>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#0f172a;padding:20px 32px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:top">
          <div style="font-size:12px;color:rgba(255,255,255,.5)">NNC Nakshatra Namaha Creations Pvt. Ltd.<br/>${bi.addr}</div>
          <div style="font-size:12px;color:#7c3aed;margin-top:6px">${bi.phone}</div>
        </td>
        <td style="text-align:right;vertical-align:top">
          <div style="font-size:11px;color:rgba(255,255,255,.35)">nakshatranamahacreations.com</div>
          <div style="font-size:11px;color:rgba(255,255,255,.35);margin-top:2px">GSTIN: 29AABCN1234F1Z5</div>
        </td>
      </tr>
    </table>
  </div>
</div>`;

    let emailSent = true;
    let emailError = null;
    try {
      await sendEmail({
        to:      q.clientEmail,
        cc:      q.senderEmail || undefined,
        subject: `Quotation ${q.quoteNumber} from NNC — ${q.clientName}`,
        html,
        replyTo: q.senderEmail || undefined,
      });
    } catch (mailErr) {
      console.error("sendQuotationEmail mail error:", mailErr.message);
      emailSent = false;
      emailError = mailErr.message;
    }

    await Quotation.findByIdAndUpdate(q._id, { status: "sent", sentAt: new Date() });

    if (!emailSent) {
      return res.status(200).json({
        success: true,
        emailSent: false,
        message: `Status marked as Sent, but email failed: ${emailError}`,
      });
    }

    const msg = q.senderEmail
      ? `Quotation emailed to ${q.clientEmail} (cc: ${q.senderEmail})`
      : `Quotation emailed to ${q.clientEmail}`;
    return res.json({ success: true, emailSent: true, message: msg });
  } catch (err) {
    console.error("sendQuotationEmail error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// DELETE /api/quotations/:id
export async function deleteQuotation(req, res) {
  try {
    const q = await Quotation.findById(req.params.id);
    if (!q) return res.status(404).json({ success: false, message: "Quotation not found" });
    await Quotation.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Quotation deleted" });
  } catch (err) {
    console.error("deleteQuotation error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}
