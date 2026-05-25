import PDFDocument from "pdfkit";

const BRANCH_INFO = {
  Bangalore: { addr: "No. 45, 2nd Floor, HSR Layout, Bengaluru – 560102", phone: "+91 99005 66466" },
  Mysore:    { addr: "Saraswathipuram, Mysuru – 570009",                   phone: "+91 99005 66466" },
  Mumbai:    { addr: "Andheri East, Mumbai – 400069",                      phone: "+91 99005 66466" },
};

const fmtINR  = (n) => `Rs. ${Number(n || 0).toLocaleString("en-IN")}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "";

export default function generateQuotationPDF(q) {
  return new Promise((resolve, reject) => {
    try {
      const doc    = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end",  ()  => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const bi = BRANCH_INFO[q.branch] || BRANCH_INFO.Bangalore;

      /* ── Header band ── */
      doc.rect(0, 0, doc.page.width, 90).fill("#0f172a");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(20).text("NNC", 50, 30);
      doc.font("Helvetica").fontSize(9).fillColor("#cbd5e1").text("Nakshatra Namaha Creations Pvt. Ltd.", 50, 55);

      doc.font("Helvetica-Bold").fontSize(9).fillColor("#94a3b8").text("QUOTATION", 0, 30, { align: "right", width: doc.page.width - 50 });
      doc.font("Helvetica-Bold").fontSize(14).fillColor("#a78bfa").text(q.quoteNumber || "—", 0, 45, { align: "right", width: doc.page.width - 50 });
      doc.font("Helvetica").fontSize(9).fillColor("#cbd5e1").text(`Branch: ${q.branch || "—"}`, 0, 65, { align: "right", width: doc.page.width - 50 });

      doc.fillColor("#000000");
      doc.y = 110;

      /* ── Bill To + Meta ── */
      const topY = doc.y;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748b").text("BILL TO", 50, topY);
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text(q.clientName || "—", 50, topY + 14);
      let yy = topY + 30;
      if (q.clientCompany) { doc.font("Helvetica").fontSize(10).fillColor("#475569").text(q.clientCompany, 50, yy); yy += 14; }
      if (q.clientAddress) { doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(q.clientAddress, 50, yy, { width: 260 }); yy += 14; }
      if (q.clientPhone)   { doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(`Phone: ${q.clientPhone}`, 50, yy); yy += 12; }
      if (q.clientEmail)   { doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(`Email: ${q.clientEmail}`, 50, yy); yy += 12; }
      if (q.clientGstin)   { doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(`GSTIN: ${q.clientGstin}`, 50, yy); yy += 12; }

      const rightX = 330;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748b").text("DETAILS", rightX, topY);
      doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(`Date: ${fmtDate(new Date())}`, rightX, topY + 16);
      if (q.validUntil) doc.text(`Valid Until: ${fmtDate(q.validUntil)}`, rightX, topY + 30);
      if (q.revisionNumber > 1) doc.fillColor("#7c3aed").text(`Revision ${q.revisionNumber}`, rightX, topY + 44);

      doc.y = Math.max(yy, topY + 70) + 14;

      /* ── Items table ── */
      const tableTop = doc.y;
      const colX = { desc: 50, qty: 320, rate: 380, amt: 470 };

      doc.rect(50, tableTop, doc.page.width - 100, 22).fill("#0f172a");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
      doc.text("DESCRIPTION", colX.desc + 6, tableTop + 7);
      doc.text("QTY",         colX.qty,      tableTop + 7, { width: 50, align: "center" });
      doc.text("RATE",        colX.rate,     tableTop + 7, { width: 80, align: "right" });
      doc.text("AMOUNT",      colX.amt,      tableTop + 7, { width: 75, align: "right" });

      let rowY = tableTop + 22;
      doc.font("Helvetica").fontSize(10).fillColor("#0f172a");

      (q.lineItems || []).forEach((item, i) => {
        const descHeight = doc.heightOfString(item.description || "—", { width: 260 });
        const rowH = Math.max(descHeight + 10, 22);

        if (i % 2 === 0) doc.rect(50, rowY, doc.page.width - 100, rowH).fill("#f8fafc");
        doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
        doc.text(item.description || "—", colX.desc + 6, rowY + 6, { width: 260 });
        doc.text(String(item.qty || 0),   colX.qty,      rowY + 6, { width: 50, align: "center" });
        doc.text(fmtINR(item.rate),       colX.rate,     rowY + 6, { width: 80, align: "right" });
        doc.font("Helvetica-Bold").text(fmtINR(item.amount), colX.amt, rowY + 6, { width: 75, align: "right" });

        rowY += rowH;

        if (rowY > doc.page.height - 200) {
          doc.addPage();
          rowY = 50;
        }
      });

      /* ── Totals ── */
      rowY += 8;
      doc.moveTo(50, rowY).lineTo(doc.page.width - 50, rowY).strokeColor("#e2e8f0").stroke();
      rowY += 8;

      const totalsLine = (label, value, opts = {}) => {
        doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.big ? 13 : 10).fillColor(opts.color || "#0f172a");
        doc.text(label, 350, rowY, { width: 120, align: "right" });
        doc.text(value, 470, rowY, { width: 75, align: "right" });
        rowY += opts.big ? 22 : 16;
      };

      totalsLine("Subtotal", fmtINR(q.subtotal));
      if (q.discount > 0) totalsLine("Discount", `- ${fmtINR(q.discount)}`, { color: "#16a34a" });
      if (q.tax > 0) {
        const taxAmt = ((Number(q.subtotal || 0) - Number(q.discount || 0)) * Number(q.tax)) / 100;
        totalsLine(`GST (${q.tax}%)`, fmtINR(taxAmt));
      }
      doc.rect(340, rowY - 2, doc.page.width - 390, 24).fill("#f1f5f9");
      totalsLine("TOTAL", fmtINR(q.total), { bold: true, big: true, color: "#7c3aed" });

      rowY += 6;

      /* ── Notes / Terms ── */
      const block = (title, body, bg, border) => {
        if (!body) return;
        if (rowY > doc.page.height - 150) { doc.addPage(); rowY = 50; }
        const h = doc.heightOfString(body, { width: doc.page.width - 130 }) + 28;
        doc.rect(50, rowY, doc.page.width - 100, h).fill(bg);
        doc.rect(50, rowY, 3, h).fill(border);
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text(title, 65, rowY + 8);
        doc.font("Helvetica").fontSize(9).fillColor("#475569").text(body, 65, rowY + 22, { width: doc.page.width - 130 });
        rowY += h + 8;
      };

      block("Notes",              q.notes, "#f8fafc", "#7c3aed");
      block("Terms & Conditions", q.terms, "#fefce8", "#eab308");

      /* ── Footer ── */
      const footerY = doc.page.height - 60;
      doc.rect(0, footerY, doc.page.width, 60).fill("#0f172a");
      doc.font("Helvetica").fontSize(8).fillColor("#94a3b8");
      doc.text(`NNC Nakshatra Namaha Creations Pvt. Ltd.`, 50, footerY + 14);
      doc.text(bi.addr, 50, footerY + 26);
      doc.fillColor("#a78bfa").text(bi.phone, 50, footerY + 38);
      doc.fillColor("#94a3b8").text("nakshatranamahacreations.com", 0, footerY + 26, { align: "right", width: doc.page.width - 50 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
