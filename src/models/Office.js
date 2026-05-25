import mongoose from "mongoose";

const officeSchema = new mongoose.Schema(
  {
    key:     { type: String, required: true, unique: true, enum: ["Mysore", "Bangalore", "Mumbai"] },
    name:    { type: String, default: "" },
    address: { type: String, default: "" },
    city:    { type: String, default: "" },
    state:   { type: String, default: "" },
    pincode: { type: String, default: "" },
    phone:   { type: String, default: "" },
    email:   { type: String, default: "" },
    gstin:   { type: String, default: "" },
  },
  { collection: "offices", timestamps: true }
);

const Office = mongoose.models.Office || mongoose.model("Office", officeSchema);

export default Office;
