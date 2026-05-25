import express from "express";
import { getOffices, updateOffice } from "../controllers/office.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.get("/",     getOffices);
router.put("/:key", updateOffice);

export default router;
