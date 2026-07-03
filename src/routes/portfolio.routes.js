import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  listPortfolio,
  createPortfolioItem,
  updatePortfolioItem,
  deletePortfolioItem,
  seedPortfolio,
} from "../controllers/portfolio.controller.js";

const router = express.Router();

// Public read (website fetches this)
router.get("/", listPortfolio);

// Protected write (admin only)
router.post("/",       protect, createPortfolioItem);
router.put("/:id",    protect, updatePortfolioItem);
router.delete("/:id", protect, deletePortfolioItem);
router.post("/seed",  protect, seedPortfolio);

export default router;
