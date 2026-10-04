import jwt from "jsonwebtoken";

import { SESSION_SECRET } from "../lib/sessionSecret.js";

/** Only Robi (018) and Airtel/Circle (016) numbers can sign in via bdApps. */
const SUPPORTED_LOCAL_NUMBER_PATTERN = /^01[68]\d{8}$/;

export const UNSUPPORTED_OPERATOR_ERROR =
  "Only Robi (018) or Airtel (016) numbers can be used to sign in";

/**
 * Accepts 01XXXXXXXXX, 8801XXXXXXXXX or +8801XXXXXXXXX (spaces and dashes
 * ignored) and returns the 11-digit local form, or null when the input is
 * not a Bangladeshi mobile number.
 */
export const toLocalMobileNumber = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  let digits = value.replace(/[\s-]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("880")) digits = digits.slice(2);
  return /^01\d{9}$/.test(digits) ? digits : null;
};

export const isSupportedOperatorNumber = (localNumber: string): boolean =>
  SUPPORTED_LOCAL_NUMBER_PATTERN.test(localNumber);

/**
 * Every spelling of the number that may already be stored in
 * users.mobile_number, so accounts created before phone sign-in still match.
 */
export const storedMobileNumberVariants = (localNumber: string): string[] => [
  localNumber,
  `88${localNumber}`,
  `+88${localNumber}`,
];

/**
 * users.email is NOT NULL and unique, so accounts created through phone
 * sign-in get a synthetic, non-deliverable address derived from the number.
 */
export const PHONE_ACCOUNT_EMAIL_DOMAIN = "phone.mealager.local";

export const phoneAccountEmail = (localNumber: string, suffix?: string) =>
  `${localNumber}${suffix ? `.${suffix}` : ""}@${PHONE_ACCOUNT_EMAIL_DOMAIN}`;

// ---------------------------------------------------------------------------
// OTP session token
//
// bdApps returns a reference number that identifies the OTP challenge, but it
// is the client that sends it back for verification. Signing the pair
// (number, referenceNo) keeps a caller from verifying their own OTP and then
// claiming a different number — without adding a table for it.
// ---------------------------------------------------------------------------

const OTP_SESSION_TTL_SECONDS = 10 * 60;
const OTP_SESSION_PURPOSE = "bdapps-phone-login";

interface OtpSessionPayload {
  purpose: typeof OTP_SESSION_PURPOSE;
  mobileNumber: string;
  referenceNo: string;
}

export const signOtpSession = (mobileNumber: string, referenceNo: string) =>
  jwt.sign(
    {
      purpose: OTP_SESSION_PURPOSE,
      mobileNumber,
      referenceNo,
    } satisfies OtpSessionPayload,
    SESSION_SECRET,
    { expiresIn: OTP_SESSION_TTL_SECONDS },
  );

export const readOtpSession = (
  token: unknown,
): { mobileNumber: string; referenceNo: string } | null => {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET) as Partial<
      OtpSessionPayload & { userId: unknown }
    >;
    if (
      payload.purpose !== OTP_SESSION_PURPOSE ||
      typeof payload.mobileNumber !== "string" ||
      typeof payload.referenceNo !== "string"
    ) {
      return null;
    }
    return {
      mobileNumber: payload.mobileNumber,
      referenceNo: payload.referenceNo,
    };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// In-memory throttling
//
// The database schema cannot change, so the per-number cooldown and the
// per-challenge guess limit live in process memory. They reset on restart,
// which is acceptable for a single API process.
// ---------------------------------------------------------------------------

export const OTP_SEND_COOLDOWN_MS = 60_000;
export const MAX_OTP_VERIFY_ATTEMPTS = 5;

const lastSentAt = new Map<string, number>();
const failedAttempts = new Map<string, { count: number; expiresAt: number }>();

const pruneExpired = (now: number) => {
  for (const [number, sentAt] of lastSentAt) {
    if (now - sentAt >= OTP_SEND_COOLDOWN_MS) lastSentAt.delete(number);
  }
  for (const [referenceNo, entry] of failedAttempts) {
    if (now >= entry.expiresAt) failedAttempts.delete(referenceNo);
  }
};

/** Seconds left before another OTP may be sent to this number, or 0. */
export const otpSendCooldownRemaining = (localNumber: string): number => {
  const sentAt = lastSentAt.get(localNumber);
  if (sentAt == null) return 0;
  const remaining = OTP_SEND_COOLDOWN_MS - (Date.now() - sentAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
};

export const markOtpSent = (localNumber: string) => {
  const now = Date.now();
  pruneExpired(now);
  lastSentAt.set(localNumber, now);
};

export const isOtpChallengeExhausted = (referenceNo: string): boolean =>
  (failedAttempts.get(referenceNo)?.count ?? 0) >= MAX_OTP_VERIFY_ATTEMPTS;

export const registerFailedOtpVerification = (referenceNo: string) => {
  const now = Date.now();
  pruneExpired(now);
  const current = failedAttempts.get(referenceNo);
  failedAttempts.set(referenceNo, {
    count: (current?.count ?? 0) + 1,
    expiresAt: now + OTP_SESSION_TTL_SECONDS * 1000,
  });
};

export const clearOtpChallenge = (referenceNo: string) => {
  failedAttempts.delete(referenceNo);
};
