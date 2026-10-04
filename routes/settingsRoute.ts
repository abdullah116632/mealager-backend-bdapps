import { Router } from "express";

import {
  deleteAccount,
  deleteMess,
  getEligibleAdmins,
  updateMess,
  updatePhone,
  updateProfile,
} from "../controllers/settingsController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get(
  "/settings/security/eligible-admins",
  requireAuth,
  getEligibleAdmins,
);
router.patch("/settings/profile", requireAuth, updateProfile);
router.patch("/settings/profile/phone", requireAuth, updatePhone);
router.delete("/settings/account", requireAuth, deleteAccount);
router.patch("/settings/mess", requireAuth, updateMess);
router.delete("/settings/mess", requireAuth, deleteMess);

export default router;
