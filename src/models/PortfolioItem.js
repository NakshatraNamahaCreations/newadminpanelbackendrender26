import mongoose from "mongoose";

const PortfolioItemSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    type:        { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: [
        "Website Development",
        "Mobile Apps",
        "CRM & Web Apps",
        "Animation",
        "Corporate Video",
        "Digital Marketing",
      ],
    },
    tech:        { type: [String], default: [] },
    result:      { type: String, default: "", trim: true },
    resultColor: { type: String, default: "#059669", trim: true },
    bg:          { type: String, default: "", trim: true },
    logo:        { type: String, default: "", trim: true },
    videoId:     { type: String, default: "", trim: true },
    isVisible:   { type: Boolean, default: true },
    sortOrder:   { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("PortfolioItem", PortfolioItemSchema);
