import Office from "../models/Office.js";

const DEFAULTS = {
  Mysore: {
    name: "Nakshatra Namaha Creations",
    address: "No. 472, Kantharaj Urs Road, Saraswathipuram",
    city: "Mysore", state: "Karnataka", pincode: "570009",
    phone: "+91 97408 75291",
    email: "info@nakshatranamaha.com",
    gstin: "29AABCN1234A1ZX",
  },
  Bangalore: {
    name: "Nakshatra Namaha Creations",
    address: "No. 123, 3rd Floor, Residency Road, Richmond Town",
    city: "Bangalore", state: "Karnataka", pincode: "560025",
    phone: "+91 97408 75291",
    email: "bangalore@nakshatranamaha.com",
    gstin: "29AABCN1234A1ZY",
  },
  Mumbai: {
    name: "Nakshatra Namaha Creations",
    address: "Office 402, 4th Floor, Veera Desai Road, Andheri West",
    city: "Mumbai", state: "Maharashtra", pincode: "400058",
    phone: "+91 97408 75291",
    email: "mumbai@nakshatranamaha.com",
    gstin: "27AABCN1234A1ZX",
  },
};

/* Build a { Mysore: {...}, Bangalore: {...}, Mumbai: {...} } map,
   filling in defaults for any keys that don't yet exist in the DB. */
async function buildOfficesMap() {
  const rows = await Office.find({}).lean();
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const row = byKey[key];
    out[key] = row
      ? {
          name:    row.name    || DEFAULTS[key].name,
          address: row.address ?? DEFAULTS[key].address,
          city:    row.city    ?? DEFAULTS[key].city,
          state:   row.state   ?? DEFAULTS[key].state,
          pincode: row.pincode ?? DEFAULTS[key].pincode,
          phone:   row.phone   ?? DEFAULTS[key].phone,
          email:   row.email   ?? DEFAULTS[key].email,
          gstin:   row.gstin   ?? DEFAULTS[key].gstin,
        }
      : { ...DEFAULTS[key] };
  }
  return out;
}

// GET /api/offices
export async function getOffices(req, res) {
  try {
    const data = await buildOfficesMap();
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getOffices error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// PUT /api/offices/:key
export async function updateOffice(req, res) {
  try {
    const { key } = req.params;
    if (!DEFAULTS[key]) {
      return res.status(400).json({ success: false, message: `Unknown office: ${key}` });
    }

    const { name, address, city, state, pincode, phone, email, gstin } = req.body || {};
    const update = {
      key,
      name:    name    ?? "",
      address: address ?? "",
      city:    city    ?? "",
      state:   state   ?? "",
      pincode: pincode ?? "",
      phone:   phone   ?? "",
      email:   email   ?? "",
      gstin:   gstin   ?? "",
    };

    await Office.findOneAndUpdate(
      { key },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const data = await buildOfficesMap();
    return res.json({ success: true, data });
  } catch (err) {
    console.error("updateOffice error:", err);
    if (err.name === "ValidationError") return res.status(400).json({ success: false, message: err.message });
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}
