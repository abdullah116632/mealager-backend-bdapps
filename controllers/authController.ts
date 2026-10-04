import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { eq, and, inArray, asc } from "drizzle-orm";
import {
  db,
  usersTable,
  messesTable,
  consumersTable,
  memberRequestsTable,
} from "../db/dbConfig.js";
import { signToken, type AuthedRequest } from "../middleware/auth.js";
import {
  BdappsAlreadySubscribedError,
  BdappsOtpError,
  checkBdappsSubscription,
  sendBdappsOtp,
  unsubscribeBdapps,
  verifyBdappsOtp,
} from "../lib/bdappsOtp.js";
import { toPublicAuthUser } from "../utils/authUtils.js";
import { hashPassword } from "../utils/passwordUtils.js";
import {
  UNSUPPORTED_OPERATOR_ERROR,
  clearOtpChallenge,
  isOtpChallengeExhausted,
  isSupportedOperatorNumber,
  markOtpSent,
  otpSendCooldownRemaining,
  phoneAccountEmail,
  readOtpSession,
  registerFailedOtpVerification,
  signOtpSession,
  storedMobileNumberVariants,
  toLocalMobileNumber,
} from "../utils/phoneAuthUtils.js";

const OTP_ATTEMPTS_EXHAUSTED_ERROR =
  "Too many incorrect attempts. Please request a new code.";

const respondWithBdappsError = (req: Request, res: Response, err: unknown) => {
  if (err instanceof BdappsOtpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  req.log.error({ err }, "bdApps OTP request failed");
  res.status(502).json({ error: "OTP service is unavailable. Please try again." });
};

const findOrCreatePhoneUser = async (mobileNumber: string) => {
  // Several legacy accounts may carry the same number; the oldest one wins so
  // the same person always lands in the same account.
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(
      inArray(usersTable.mobileNumber, storedMobileNumberVariants(mobileNumber)),
    )
    .orderBy(asc(usersTable.id))
    .limit(1);
  if (existing) return existing;

  // The password is random and never shown: phone accounts never use it.
  const passwordHash = await hashPassword(`phone:${randomUUID()}`);
  const values = {
    name: mobileNumber,
    passwordHash,
    mobileNumber,
  };

  const [created] = await db
    .insert(usersTable)
    .values({ ...values, email: phoneAccountEmail(mobileNumber) })
    .onConflictDoNothing({ target: usersTable.email })
    .returning();
  if (created) return created;

  // The synthetic address is taken by an account whose number has since
  // changed; give this one a unique address instead of reusing that account.
  const [fallback] = await db
    .insert(usersTable)
    .values({
      ...values,
      email: phoneAccountEmail(mobileNumber, randomUUID().slice(0, 8)),
    })
    .returning();
  return fallback;
};

const readSupportedNumber = (req: Request, res: Response): string | null => {
  const mobileNumber = toLocalMobileNumber(req.body?.mobileNumber);
  if (!mobileNumber) {
    res
      .status(400)
      .json({ error: "Please enter a valid 11-digit mobile number" });
    return null;
  }
  if (!isSupportedOperatorNumber(mobileNumber)) {
    res.status(400).json({ error: UNSUPPORTED_OPERATOR_ERROR });
    return null;
  }
  return mobileNumber;
};

const respondWithSubscribedSession = async (
  res: Response,
  mobileNumber: string,
) => {
  const user = await findOrCreatePhoneUser(mobileNumber);
  res.json({
    subscribed: true,
    mobileNumber,
    token: signToken(user.id),
    user: toPublicAuthUser(user),
  });
};

const isNumberSubscribed = async (req: Request, mobileNumber: string) => {
  const subscription = await checkBdappsSubscription(mobileNumber);
  req.log.info(
    { mobileNumber, subscription: subscription.response },
    "bdApps subscription check",
  );
  return subscription.subscribed;
};

// POST /api/auth/phone/login — body: { mobileNumber }
// Signs in a number whose bdApps subscription status is REGISTERED or
// INITIAL CHARGING PENDING. Never sends an OTP, so the app can call it on
// start-up with the number it remembered; any other status gets
// { subscribed: false }.
export const phoneLogin = async (req: Request, res: Response) => {
  const mobileNumber = readSupportedNumber(req, res);
  if (!mobileNumber) return;

  if (await isNumberSubscribed(req, mobileNumber)) {
    await respondWithSubscribedSession(res, mobileNumber);
    return;
  }
  res.json({ subscribed: false, mobileNumber });
};

// POST /api/auth/phone/send-otp — body: { mobileNumber }
// A subscribed number is signed in straight away and gets { token, user }.
// Otherwise a bdApps OTP is sent and the response carries a signed session
// that ties the bdApps reference number to that number, for
// /auth/phone/verify-otp.
export const sendPhoneOtp = async (req: Request, res: Response) => {
  const mobileNumber = readSupportedNumber(req, res);
  if (!mobileNumber) return;

  if (await isNumberSubscribed(req, mobileNumber)) {
    await respondWithSubscribedSession(res, mobileNumber);
    return;
  }

  const cooldown = otpSendCooldownRemaining(mobileNumber);
  if (cooldown > 0) {
    res.status(429).json({
      error: `Please wait ${cooldown} seconds before requesting another code`,
      retryAfterSeconds: cooldown,
    });
    return;
  }

  let referenceNo: string;
  try {
    referenceNo = await sendBdappsOtp(mobileNumber);
  } catch (err) {
    // The subscription check can miss a subscribed number; bdApps itself
    // then refuses the OTP, which confirms the subscription.
    if (err instanceof BdappsAlreadySubscribedError) {
      await respondWithSubscribedSession(res, mobileNumber);
      return;
    }
    respondWithBdappsError(req, res, err);
    return;
  }
  markOtpSent(mobileNumber);

  res.json({
    subscribed: false,
    message: "OTP sent",
    mobileNumber,
    otpSession: signOtpSession(mobileNumber, referenceNo),
  });
};

// POST /api/auth/phone/verify-otp — body: { otpSession, otp }
// Verifies the OTP with bdApps, then signs in the account that owns the
// number, creating one on first sign-in.
export const verifyPhoneOtp = async (req: Request, res: Response) => {
  const { otpSession, otp } = req.body ?? {};
  const session = readOtpSession(otpSession);
  if (!session) {
    res
      .status(410)
      .json({ error: "Code expired. Please request a new one." });
    return;
  }

  const code = typeof otp === "string" || typeof otp === "number"
    ? String(otp).trim()
    : "";
  if (!/^\d{4,8}$/.test(code)) {
    res.status(400).json({ error: "Please enter the code you received" });
    return;
  }
  if (isOtpChallengeExhausted(session.referenceNo)) {
    res.status(429).json({ error: OTP_ATTEMPTS_EXHAUSTED_ERROR });
    return;
  }

  try {
    await verifyBdappsOtp(session.referenceNo, code, session.mobileNumber);
  } catch (err) {
    if (err instanceof BdappsOtpError && err.status === 401) {
      registerFailedOtpVerification(session.referenceNo);
      if (isOtpChallengeExhausted(session.referenceNo)) {
        res.status(429).json({ error: OTP_ATTEMPTS_EXHAUSTED_ERROR });
        return;
      }
    }
    respondWithBdappsError(req, res, err);
    return;
  }
  clearOtpChallenge(session.referenceNo);

  const user = await findOrCreatePhoneUser(session.mobileNumber);
  const token = signToken(user.id);
  res.json({
    token,
    mobileNumber: session.mobileNumber,
    user: toPublicAuthUser(user),
  });
};

// POST /api/auth/phone/unsubscribe — cancels the bdApps subscription of the
// signed-in user's own number. The app signs out afterwards.
export const unsubscribePhone = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const [user] = await db
    .select({ mobileNumber: usersTable.mobileNumber })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const mobileNumber = toLocalMobileNumber(user.mobileNumber);
  if (!mobileNumber || !isSupportedOperatorNumber(mobileNumber)) {
    res.status(400).json({
      error: "This account has no Robi or Airtel number to unsubscribe",
    });
    return;
  }

  try {
    const result = await unsubscribeBdapps(mobileNumber);
    req.log.info({ userId, result }, "bdApps unsubscribe succeeded");
  } catch (err) {
    respondWithBdappsError(req, res, err);
    return;
  }

  res.json({ success: true });
};

// GET /api/auth/me — returns all messes + all pending/rejected requests
export const me = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;

  // These datasets are independent. Fetch them in parallel and join the
  // membership/request names in SQL to avoid 4-6 sequential Neon round trips.
  const [userRows, adminMesses, memberships, requestRecords] =
    await Promise.all([
      db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          name: usersTable.name,
          mobileNumber: usersTable.mobileNumber,
          googleSubject: usersTable.googleSubject,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1),
      db
        .select({
          id: messesTable.id,
          name: messesTable.name,
          messKey: messesTable.messKey,
        })
        .from(messesTable)
        .where(eq(messesTable.adminUserId, userId)),
      db
        .select({
          id: messesTable.id,
          name: messesTable.name,
          messKey: messesTable.messKey,
          isAdmin: consumersTable.isAdmin,
        })
        .from(consumersTable)
        .innerJoin(messesTable, eq(consumersTable.messId, messesTable.id))
        .where(eq(consumersTable.userId, userId)),
      db
        .select({
          id: memberRequestsTable.id,
          messId: memberRequestsTable.messId,
          messName: messesTable.name,
          status: memberRequestsTable.status,
        })
        .from(memberRequestsTable)
        .innerJoin(messesTable, eq(memberRequestsTable.messId, messesTable.id))
        .where(
          and(
            eq(memberRequestsTable.userId, userId),
            inArray(memberRequestsTable.status, ["pending", "rejected"]),
          ),
        ),
    ]);

  const user = userRows[0];
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const messMap = new Map<
    number,
    {
      id: number;
      name: string;
      messKey: string;
      role: "admin" | "member";
      // The mess creator (messesTable.adminUserId), as opposed to a co-admin
      // granted admin via Add Co-Admin. Informational only: under v2 every
      // manager action — renaming or deleting the mess, adding a co-admin,
      // transferring the role, stepping down — is open to any admin, so
      // permission checks belong on `role`. Being primary still decides the
      // "Primary Manager" badge, and the legacy v1 /settings/security/*
      // endpoints kept for older app builds are still primary-only.
      isPrimaryAdmin: boolean;
    }
  >();
  for (const mess of adminMesses) {
    messMap.set(mess.id, { ...mess, role: "admin", isPrimaryAdmin: true });
  }
  for (const membership of memberships) {
    if (!messMap.has(membership.id)) {
      messMap.set(membership.id, {
        id: membership.id,
        name: membership.name,
        messKey: membership.messKey,
        role: membership.isAdmin ? "admin" : "member",
        isPrimaryAdmin: false,
      });
    }
  }

  const messes = [...messMap.values()];
  const requests = requestRecords.map((request) => ({
    id: request.id,
    messId: request.messId,
    messName: request.messName,
    status: request.status as "pending" | "rejected",
  }));

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mobileNumber: user.mobileNumber,
      hasGoogleAccount: user.googleSubject != null,
    },
    messes,
    requests,
  });
};
