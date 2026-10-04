import { Router } from "express";

import {
  me,
  phoneLogin,
  sendPhoneOtp,
  unsubscribePhone,
  verifyPhoneOtp,
} from "../controllers/authController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/auth/phone/login", phoneLogin);
router.post("/auth/phone/send-otp", sendPhoneOtp);
router.post("/auth/phone/verify-otp", verifyPhoneOtp);
router.post("/auth/phone/unsubscribe", requireAuth, unsubscribePhone);
router.get("/auth/me", requireAuth, me);

export default router;
