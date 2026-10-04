/**
 * Thin client for the bdApps OTP bridge. The bridge is a PHP script that
 * expects form-encoded bodies, so everything here goes out as
 * application/x-www-form-urlencoded.
 */

const SEND_OTP_URL =
  process.env.BDAPPS_SEND_OTP_URL ??
  "https://bdapps.flicksize.com/mealager/api/send_otp.php";
const VERIFY_OTP_URL =
  process.env.BDAPPS_VERIFY_OTP_URL ??
  "https://bdapps.flicksize.com/mealager/api/verify_otp.php";

const CHECK_SUBSCRIPTION_URL =
  process.env.BDAPPS_CHECK_SUBSCRIPTION_URL ??
  "https://bdapps.flicksize.com/mealager/api/check_subscription.php";
const UNSUBSCRIBE_URL =
  process.env.BDAPPS_UNSUBSCRIBE_URL ??
  "https://bdapps.flicksize.com/mealager/api/unsubscribe.php";

// Kept below the app's own 20s request timeout so the app sees our error.
const REQUEST_TIMEOUT_MS = 15_000;

/** bdApps reports a successful OTP verification with this status code. */
const BDAPPS_SUCCESS_CODE = "S1000";

export class BdappsOtpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const postForm = async (
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> => {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new BdappsOtpError(
      "Could not reach the OTP service. Please try again.",
      502,
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new BdappsOtpError(
      "The OTP service returned an invalid response. Please try again.",
      502,
    );
  }
};

const readMessage = (body: Record<string, unknown>, fallback: string) => {
  for (const key of ["error", "message", "statusDetail"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
};

/** bdApps subscription states in which the number is already signed up. */
const SUBSCRIBED_STATUSES = new Set(["REGISTERED", "INITIAL CHARGING PENDING"]);

/**
 * Whether bdApps reports the number as already subscribed, plus the raw
 * answer for logging. Any error or unexpected answer counts as not
 * subscribed, so the caller falls back to the OTP flow.
 */
export const checkBdappsSubscription = async (
  localNumber: string,
): Promise<{ subscribed: boolean; response: unknown }> => {
  try {
    const body = await postForm(CHECK_SUBSCRIPTION_URL, {
      user_mobile: localNumber,
    });
    const status =
      typeof body.subscriptionStatus === "string"
        ? body.subscriptionStatus.trim().toUpperCase()
        : "";
    return {
      subscribed: SUBSCRIBED_STATUSES.has(status),
      response: body,
    };
  } catch (err) {
    return { subscribed: false, response: String(err) };
  }
};

/**
 * bdApps refuses to send a subscription OTP to a number that is already
 * subscribed. The caller signs such a number in directly.
 */
export class BdappsAlreadySubscribedError extends BdappsOtpError {
  constructor(message: string) {
    super(message, 409);
  }
}

const ALREADY_SUBSCRIBED_CODES = new Set(["E1351"]);
const ALREADY_SUBSCRIBED_PATTERN = /already\s+(registered|subscribed)/i;

const findStatusCode = (body: Record<string, unknown>): string | null => {
  const nested =
    body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>).statusCode
      : undefined;
  for (const value of [body.statusCode, nested]) {
    if (typeof value === "string") return value;
  }
  return null;
};

/**
 * Asks bdApps to send an OTP to a Robi/Airtel (Circle) number and returns the
 * reference number that identifies this OTP challenge.
 *
 * `localNumber` is the 11-digit 01XXXXXXXXX form. The same value is sent
 * under the field names the bridge script is known to read.
 */
export const sendBdappsOtp = async (localNumber: string): Promise<string> => {
  const body = await postForm(SEND_OTP_URL, {
    user_mobile: localNumber,
    mobile: localNumber,
    mobileNumber: localNumber,
    phone: localNumber,
  });

  const referenceNo = body.referenceNo;
  if (
    body.success !== true ||
    typeof referenceNo !== "string" ||
    !referenceNo.trim()
  ) {
    const message = readMessage(
      body,
      "Failed to send the OTP. Please try again.",
    );
    const statusCode = findStatusCode(body);
    if (
      (statusCode && ALREADY_SUBSCRIBED_CODES.has(statusCode)) ||
      ALREADY_SUBSCRIBED_PATTERN.test(JSON.stringify(body))
    ) {
      throw new BdappsAlreadySubscribedError(message);
    }
    throw new BdappsOtpError(message, 400);
  }
  return referenceNo.trim();
};

const readField = (body: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = body[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
};

/**
 * Resolves when bdApps accepts the OTP for this reference number. The OTP and
 * reference go out under every field name the bridge script is known to
 * read, and any of the bridge's success shapes counts.
 */
export const verifyBdappsOtp = async (
  referenceNo: string,
  otp: string,
  localNumber: string,
): Promise<void> => {
  const body = await postForm(VERIFY_OTP_URL, {
    Otp: otp,
    otp,
    referenceNo,
    reference_no: referenceNo,
    user_mobile: localNumber,
  });
  const statusCode = readField(body, [
    "statusCode",
    "StatusCode",
    "status_code",
  ]).toUpperCase();
  const accepted =
    statusCode === BDAPPS_SUCCESS_CODE ||
    body.success === true ||
    readField(body, ["status", "result"]).toLowerCase() === "success";
  if (!accepted) {
    throw new BdappsOtpError(
      readField(body, ["message", "statusDetail", "error", "errorMessage"]) ||
        "Incorrect code. Please try again.",
      401,
    );
  }
};

/**
 * Cancels the bdApps subscription of a Robi/Airtel number. Resolves with the
 * bridge's raw response so the caller can log it.
 */
export const unsubscribeBdapps = async (
  localNumber: string,
): Promise<Record<string, unknown>> => {
  const body = await postForm(UNSUBSCRIBE_URL, { user_mobile: localNumber });
  const failed =
    body.error != null ||
    body.success === false ||
    (typeof body.statusCode === "string" &&
      body.statusCode !== BDAPPS_SUCCESS_CODE);
  if (failed) {
    throw new BdappsOtpError(
      readMessage(body, "Failed to unsubscribe. Please try again."),
      400,
    );
  }
  return body;
};
