import express from "express";
import {
  getEnquiries,
  getEnquiryStats,
  exportEnquiries,
  getEnquiryById,
  createEnquiry,
  updateEnquiry,
  deleteEnquiry,
  addActivity,
  convertToLead,
  markSeen,
} from "../controllers/enquiry.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

// fixed paths MUST come before /:id
router.get("/stats",  getEnquiryStats);
router.get("/export", exportEnquiries);

router.get("/",    getEnquiries);
router.post("/",   createEnquiry);

router.get("/:id",     getEnquiryById);
router.put("/:id",     updateEnquiry);
router.delete("/:id",  deleteEnquiry);

router.patch("/:id/seen",    markSeen);
router.post("/:id/activity", addActivity);
router.post("/:id/convert",  convertToLead);

export default router;
