import PortfolioItem from "../models/PortfolioItem.js";

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/portfolio  — list (public & admin)
export const listPortfolio = async (req, res) => {
  try {
    const { category, search, visible } = req.query;
    const filter = {};

    if (visible === "true")  filter.isVisible = true;
    if (visible === "false") filter.isVisible = false;

    if (category && category !== "all") {
      filter.category = category;
    }

    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: re }, { type: re }, { category: re }, { result: re }];
    }

    const items = await PortfolioItem.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({ success: true, data: items, total: items.length });
  } catch (err) {
    console.error("listPortfolio error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /api/portfolio  — create
export const createPortfolioItem = async (req, res) => {
  try {
    const { name, type, category, tech, result, resultColor, bg, logo, videoId, isVisible, sortOrder } = req.body;

    if (!name?.trim() || !type?.trim() || !category) {
      return res.status(400).json({ success: false, message: "name, type and category are required" });
    }

    const item = await PortfolioItem.create({
      name: name.trim(),
      type: type.trim(),
      category,
      tech: Array.isArray(tech) ? tech.map(t => String(t).trim()).filter(Boolean) : [],
      result: result?.trim() || "",
      resultColor: resultColor?.trim() || "#059669",
      bg: bg?.trim() || "",
      logo: logo?.trim() || "",
      videoId: videoId?.trim() || "",
      isVisible: isVisible !== false,
      sortOrder: Number(sortOrder) || 0,
    });

    return res.status(201).json({ success: true, data: item });
  } catch (err) {
    console.error("createPortfolioItem error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// PUT /api/portfolio/:id  — update
export const updatePortfolioItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, category, tech, result, resultColor, bg, logo, videoId, isVisible, sortOrder } = req.body;

    const update = {};
    if (name       !== undefined) update.name        = name.trim();
    if (type       !== undefined) update.type        = type.trim();
    if (category   !== undefined) update.category    = category;
    if (tech       !== undefined) update.tech        = Array.isArray(tech) ? tech.map(t => String(t).trim()).filter(Boolean) : [];
    if (result     !== undefined) update.result      = result.trim();
    if (resultColor !== undefined) update.resultColor = resultColor.trim();
    if (bg         !== undefined) update.bg          = bg.trim();
    if (logo       !== undefined) update.logo        = logo.trim();
    if (videoId    !== undefined) update.videoId     = videoId.trim();
    if (isVisible  !== undefined) update.isVisible   = Boolean(isVisible);
    if (sortOrder  !== undefined) update.sortOrder   = Number(sortOrder);

    const item = await PortfolioItem.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: "Item not found" });

    return res.json({ success: true, data: item });
  } catch (err) {
    console.error("updatePortfolioItem error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// DELETE /api/portfolio/:id
export const deletePortfolioItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await PortfolioItem.findByIdAndDelete(id);
    if (!item) return res.status(404).json({ success: false, message: "Item not found" });
    return res.json({ success: true, message: "Deleted" });
  } catch (err) {
    console.error("deletePortfolioItem error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /api/portfolio/seed  — seed from existing static data (one-time)
export const seedPortfolio = async (req, res) => {
  try {
    const existing = await PortfolioItem.countDocuments();
    if (existing > 0) {
      return res.json({ success: false, message: `Already has ${existing} items. Delete them first to re-seed.` });
    }

    const WORKS = req.body.works;
    if (!Array.isArray(WORKS) || WORKS.length === 0) {
      return res.status(400).json({ success: false, message: "Provide works[] in body" });
    }

    const items = await PortfolioItem.insertMany(
      WORKS.map((w, i) => ({
        name:        w.name        || "",
        type:        w.type        || "",
        category:    w.category    || "Website Development",
        tech:        Array.isArray(w.tech) ? w.tech : [],
        result:      w.result      || "",
        resultColor: w.resultColor || "#059669",
        bg:          w.bg          || "",
        logo:        w.logo        || "",
        videoId:     w.videoId     || "",
        isVisible:   true,
        sortOrder:   i,
      }))
    );

    return res.status(201).json({ success: true, count: items.length });
  } catch (err) {
    console.error("seedPortfolio error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
