import { Resend } from "resend";

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured");
  return new Resend(key);
}

const FROM = process.env.RESEND_FROM_EMAIL ?? "Melager <onboarding@resend.dev>";

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes a value before it is interpolated into an email's HTML body.
 *
 * Member names, mess names and the address a manager types into "invite"
 * reach these templates verbatim. Without this, anyone could sign up or
 * create a mess whose name is markup and have it rendered inside a mail sent
 * from the app's own verified sending domain — a ready-made phishing page
 * delivered with the app's reputation behind it.
 *
 * Apply it to the HTML body only. Subject lines are plain-text headers, so
 * escaping them would show a real "Karim & Sons" as "Karim &amp; Sons" in the
 * inbox; they need no escaping because Resend is a JSON API, which leaves no
 * room for the CRLF header injection that raw SMTP would allow.
 */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);

export async function sendInviteEmail(
  to: string,
  inviterName: string,
  messName: string,
  messKey: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `${inviterName} invited you to join ${messName} on Melager`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">You're invited!</h2>
        <p style="color:#374151;">Hi there,</p>
        <p style="color:#374151;"><strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(messName)}</strong> on Melager.</p>
        <p style="color:#374151;">Download the app and use the key below to join:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:10px;text-align:center;
                    padding:24px;background:#F0FDFA;border:2px solid #14B8A6;
                    border-radius:12px;margin:24px 0;color:#0F766E;">
          ${messKey}
        </div>
        <p style="color:#6B7280;font-size:14px;">Open Melager → Sign up or log in → Join a mess → Enter the key above.</p>
        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated message from Melager.</p>
      </div>
    `,
  });
}

export async function sendExistingMemberAddedEmail(
  to: string,
  name: string,
  messName: string,
  messKey: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `You've been added to ${messName} on Melager`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">You've been added to a mess</h2>
        <p style="color:#374151;">Hi <strong>${escapeHtml(name)}</strong>,</p>
        <p style="color:#374151;">You have been added as a member of <strong>${escapeHtml(messName)}</strong> on Melager.</p>
        <p style="color:#374151;">You can open the app and select this mess right away. Its mess key is included below for your reference:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:10px;text-align:center;
                    padding:24px;background:#F0FDFA;border:2px solid #14B8A6;
                    border-radius:12px;margin:24px 0;color:#0F766E;">
          ${messKey}
        </div>
        <p style="color:#6B7280;font-size:14px;">No join request is needed. If you do not see the mess immediately, refresh the app or sign out and sign in again.</p>
        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated message from Melager.</p>
      </div>
    `,
  });
}

export interface ConsumerSummary {
  name: string;
  meals: number;
  cost: number;
  deposits: number;
  balance: number;
}

export async function sendMonthlySummaryEmail(
  to: string,
  name: string,
  messName: string,
  yearMonth: string,
  summary: {
    meals: number;
    cost: number;
    deposits: number;
    balance: number;
    mealRate: number;
    totalExpenses: number;
    totalMeals: number;
  },
): Promise<void> {
  const resend = getResend();

  const [year, month] = yearMonth.split("-");
  const monthLabel = new Date(
    parseInt(year!),
    parseInt(month!) - 1,
    1,
  ).toLocaleString("en-US", { month: "long", year: "numeric" });

  const fmt = (n: number) =>
    n.toLocaleString("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    });

  const balColor = summary.balance >= 0 ? "#059669" : "#DC2626";
  const balSign = summary.balance >= 0 ? "+" : "";

  await resend.emails.send({
    from: FROM,
    to,
    subject: `Your mess summary for ${monthLabel} — ${messName}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:4px;">${escapeHtml(messName)}</h2>
        <p style="color:#6B7280;margin-top:0;margin-bottom:24px;">Monthly summary for <strong>${monthLabel}</strong></p>

        <p style="color:#374151;">Hi <strong>${escapeHtml(name)}</strong>, here's your breakdown for ${monthLabel}:</p>

        <!-- Per-consumer breakdown -->
        <table style="width:100%;border-collapse:collapse;margin:24px 0;border-radius:10px;overflow:hidden;">
          <thead>
            <tr style="background:#0F766E;color:#fff;">
              <th style="text-align:left;padding:10px 14px;font-size:13px;">Item</th>
              <th style="text-align:right;padding:10px 14px;font-size:13px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style="background:#F9FAFB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Meals eaten</td>
              <td style="padding:10px 14px;color:#374151;font-size:14px;text-align:right;">${summary.meals} meals</td>
            </tr>
            <tr style="background:#fff;border-top:1px solid #E5E7EB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Meal rate</td>
              <td style="padding:10px 14px;color:#374151;font-size:14px;text-align:right;">৳${fmt(summary.mealRate)} / meal</td>
            </tr>
            <tr style="background:#F9FAFB;border-top:1px solid #E5E7EB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Your cost</td>
              <td style="padding:10px 14px;color:#DC2626;font-size:14px;font-weight:600;text-align:right;">− ৳${fmt(summary.cost)}</td>
            </tr>
            <tr style="background:#fff;border-top:1px solid #E5E7EB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Your deposits</td>
              <td style="padding:10px 14px;color:#059669;font-size:14px;font-weight:600;text-align:right;">+ ৳${fmt(summary.deposits)}</td>
            </tr>
            <tr style="background:#0F766E;border-top:1px solid #0F766E;">
              <td style="padding:12px 14px;color:#fff;font-size:15px;font-weight:700;">Balance</td>
              <td style="padding:12px 14px;font-size:15px;font-weight:700;text-align:right;color:${balColor === "#059669" ? "#A7F3D0" : "#FCA5A5"};">${balSign}৳${fmt(Math.abs(summary.balance))}</td>
            </tr>
          </tbody>
        </table>

        <!-- Mess totals -->
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
          <p style="margin:0 0 8px;color:#6B7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Mess Totals for ${monthLabel}</p>
          <p style="margin:4px 0;color:#374151;font-size:13px;">Total meals: <strong>${summary.totalMeals}</strong></p>
          <p style="margin:4px 0;color:#374151;font-size:13px;">Total expenses: <strong>৳${fmt(summary.totalExpenses)}</strong></p>
        </div>

        ${
          summary.balance < 0
            ? `<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
               <p style="margin:0;color:#DC2626;font-size:14px;font-weight:600;">⚠️ You have an outstanding balance of ৳${fmt(Math.abs(summary.balance))}. Please deposit to clear it.</p>
             </div>`
            : `<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
               <p style="margin:0;color:#059669;font-size:14px;font-weight:600;">✓ You're all clear! You have a positive balance of ৳${fmt(summary.balance)}.</p>
             </div>`
        }

        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated summary from Melager.</p>
      </div>
    `,
  });
}

export async function sendWelcomeEmail(
  to: string,
  name: string,
  messName: string,
  password: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `You've been added to ${messName} on Melager`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">Welcome to ${escapeHtml(messName)}!</h2>
        <p style="color:#374151;">Hi <strong>${escapeHtml(name)}</strong>,</p>
        <p style="color:#374151;">You've been added to <strong>${escapeHtml(messName)}</strong> on Melager. Use the credentials below to log in:</p>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:20px;margin:24px 0;">
          <p style="margin:0 0 10px;color:#374151;"><strong>Email:</strong> ${escapeHtml(to)}</p>
          <p style="margin:0;color:#374151;"><strong>Password:</strong> <code style="background:#F3F4F6;padding:2px 6px;border-radius:4px;">${password}</code></p>
        </div>
        <p style="color:#DC2626;font-size:14px;">For security, please change your password after your first login.</p>
        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated message from Melager.</p>
      </div>
    `,
  });
}
