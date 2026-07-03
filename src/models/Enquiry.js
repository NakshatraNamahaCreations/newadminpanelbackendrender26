import mongoose from "mongoose";

const ActivityLogSchema = new mongoose.Schema(
  {
    action: { type: String, default: "" },
    note:   { type: String, default: "" },
    by:     { type: String, default: "Admin" },
    at:     { type: Date,   default: Date.now },
  },
  { _id: false }
);

const EnquirySchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    phone:   { type: String, required: true, trim: true },
    email:   { type: String, default: "", lowercase: true, trim: true },
    company: { type: String, default: "", trim: true },
    services: {
      type: [String],
      default: [],
      // Allowed values: "Website Dev","Mobile App Dev","Social Media Promotions",
      // "Animation 2D/3D","Google Ads","SEO","Corporate Ad Film","Logo & Branding",
      // "E-Commerce","Photography/Videography","Custom Software","UI/UX Design"
    },
    source: {
      type: String,
      enum: ["Walk-In", "Referral", "Website", "Phone Call", "WhatsApp", "Instagram", "Google Ads", "JustDial"],
      default: "Walk-In",
    },
    // Which website / brand this enquiry belongs to:
    //   "nnc"        → NNC main website (nakshatranamahacreations.com) + CRM-created
    //   "nncdigital" → NNC Digital website
    site: {
      type: String,
      enum: ["nnc", "nncdigital"],
      default: "nnc",
    },
    budgetMin:    { type: Number, default: 0 },
    budgetMax:    { type: Number, default: 0 },
    requirements: { type: String, default: "", trim: true },
    branch: {
      type: String,
      required: true,
      enum: ["Mysore", "Bangalore", "Mumbai"],
    },
    assignedTo:       { type: String, default: "" },
    status: {
      type: String,
      enum: ["new", "contacted", "follow-up", "quoted", "won", "lost"],
      default: "new",
    },
    followUpDate:      { type: Date,    default: null },
    convertedToLead:   { type: Boolean, default: false },
    convertedLeadId:   { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    convertedAt:       { type: Date,    default: null },
    landingPage:       { type: String, default: "", trim: true },
    gstApplicable:     { type: Boolean, default: false },
    // Unread/new-lead alert: false until an admin opens the enquiry (View).
    seen:              { type: Boolean, default: false },
    activityLog:       { type: [ActivityLogSchema], default: [] },
  },
  { timestamps: true }
);

// Single-field indexes
EnquirySchema.index({ branch: 1 });
EnquirySchema.index({ landingPage: 1 });
EnquirySchema.index({ status: 1 });
EnquirySchema.index({ followUpDate: 1, status: 1 });
EnquirySchema.index({ convertedToLead: 1 });
EnquirySchema.index({ createdAt: -1 });
EnquirySchema.index({ services: 1 });
EnquirySchema.index({ source: 1, createdAt: -1 });  // source filter + date sort
EnquirySchema.index({ branch: 1, createdAt: -1 });  // branch filter + date sort
EnquirySchema.index({ site: 1, createdAt: -1 });    // site (NNC / NNC Digital) tab filter + date sort
EnquirySchema.index({ seen: 1, site: 1 });          // unseen-count alert per tab

// Text index for search
EnquirySchema.index(
  { name: "text", phone: "text", email: "text", company: "text" },
  { name: "enquiry_text_search" }
);

const Enquiry = mongoose.models.Enquiry || mongoose.model("Enquiry", EnquirySchema);

export default Enquiry;
