import type { Response } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  messesTable,
  consumersTable,
  memberRequestsTable,
  otpVerificationsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolvePrimaryAdminAccess } from "../utils/primaryAdminAccessUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { deleteUserAccountPreservingAccounting } from "../utils/accountDeletionUtils.js";
import { deleteMessAndAllData } from "../utils/messDeletionUtils.js";

// GET /api/settings/security/eligible-admins?messId=X
export const getEligibleAdmins = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolvePrimaryAdminAccess(userId, req.query.messId, {
    missingMessIdError: "messId query param is required",
    accessDeniedError: "Only the primary admin can view this",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;

  const consumers = await db
    .select({
      id: consumersTable.id,
      name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      userId: consumersTable.userId,
      isAdmin: consumersTable.isAdmin,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, mess.id));

  const eligible = consumers.filter(
    (c) => c.userId !== null && c.userId !== userId,
  );
  res.json({ consumers: eligible });
};

// PATCH /api/settings/profile — update display name
export const updateProfile = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { name } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  const normalizedName = (name as string).trim();
  if (normalizedName.length > 100) {
    res.status(400).json({ error: "Name is too long" });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [user] = await tx
      .update(usersTable)
      .set({ name: normalizedName })
      .where(eq(usersTable.id, userId))
      .returning({ email: usersTable.email });

    if (!user) return false;

    await tx
      .update(consumersTable)
      .set({ name: normalizedName })
      .where(eq(consumersTable.userId, userId));

    await tx
      .update(memberRequestsTable)
      .set({ name: normalizedName })
      .where(eq(memberRequestsTable.userId, userId));

    await tx
      .update(otpVerificationsTable)
      .set({ name: normalizedName })
      .where(eq(otpVerificationsTable.email, user.email));

    return true;
  });

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ name: normalizedName });
};

// PATCH /api/settings/profile/phone — the mobile number is the sign-in
// identity, so it can no longer be changed from the app.
export const updatePhone = async (_req: AuthedRequest, res: Response) => {
  res.status(403).json({
    error: "Your mobile number is used to sign in and cannot be changed",
  });
};

// DELETE /api/settings/account — permanently removes the login account while
// anonymizing linked consumer rows so historical accounting remains intact.
export const deleteAccount = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const outcome = await deleteUserAccountPreservingAccounting(
    userId,
    user.email,
  );

  if (outcome.blockedMessNames.length > 0) {
    res.status(409).json({
      error: `Add another admin before deleting your account in: ${outcome.blockedMessNames.join(", ")}`,
      blockingMesses: outcome.blockedMessNames,
    });
    return;
  }

  res.json({ success: true });
};

// PATCH /api/settings/mess — update mess name. Any admin of the mess may do
// this, primary or co-admin: the app has always offered the rename control to
// everyone with the admin role, and a co-admin can already do strictly more
// destructive things here (delete the mess, hand over the admin role).
export const updateMess = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { name, messId: messIdParam } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Mess name is required" });
    return;
  }
  const normalizedName = (name as string).trim();
  if (normalizedName.length > 100) {
    res.status(400).json({ error: "Mess name is too long" });
    return;
  }
  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  await db
    .update(messesTable)
    .set({ name: normalizedName })
    .where(eq(messesTable.id, access.messId));
  res.json({ name: normalizedName });
};

// DELETE /api/settings/mess — permanently deletes the mess and all of its
// data (consumers, meals, deposits, expenses, notices, bazar, etc.). Any
// admin (primary or co-admin) may do this; being signed in is the only
// identity check.
export const deleteMess = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdParam } = req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  await deleteMessAndAllData(access.messId);
  res.json({ success: true });
};
