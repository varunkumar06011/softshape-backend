// ─────────────────────────────────────────────────────────────────────────────
// Email Service — Resend Integration
// ─────────────────────────────────────────────────────────────────────────────
// Sends transactional emails via the Resend API (https://resend.com).
// Currently supports two email types:
//   1. Password reset — sent when a user requests a password reset
//   2. Welcome email — sent after successful onboarding with restaurant code and staff PINs
//
// Requires RESEND_API_KEY environment variable. The Resend client is lazily
// initialized on first use to avoid startup errors if the key is missing.
//
// Emails are sent from "Softshape <noreply@softshape.in>".
// ─────────────────────────────────────────────────────────────────────────────

import { Resend } from "resend";

// Singleton Resend client — lazily initialized on first use
let resendInstance: Resend | null = null;

// Returns the singleton Resend client, initializing it if needed.
// Throws if RESEND_API_KEY is not set in environment variables.
function getResend(): Resend {
  if (!resendInstance) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error("RESEND_API_KEY is not set");
    }
    resendInstance = new Resend(key);
  }
  return resendInstance;
}

// Sends a password reset email with a reset link.
// The reset link includes a token that the frontend uses to verify the reset request.
// The link expires after 1 hour (enforced by the backend token verification).
//
// Parameters:
//   to             — recipient email address
//   resetToken     — signed JWT token for password reset verification
//   restaurantName — restaurant name for personalization in the email body
export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  restaurantName: string
) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  await getResend().emails.send({
    from: "Softshape <noreply@softshape.in>",
    to,
    subject: `Reset your Softshape password — ${restaurantName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Password Reset</h2>
        <p>Hi, you requested a password reset for <strong>${restaurantName}</strong> on Softshape.</p>
        <p><a href="${resetUrl}" style="background:#E53935;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Reset Password</a></p>
        <p style="color:#999;font-size:12px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

// Sends a welcome email after successful onboarding.
// Includes the restaurant code (for staff login) and optionally a table of
// staff PINs (name, role, PIN) so the owner can share credentials with staff.
//
// Parameters:
//   to              — owner's email address
//   ownerName       — owner's display name
//   restaurantName  — restaurant name
//   restaurantCode  — the join code staff use to log in
//   staffPins       — optional array of { name, pin, role } for staff credentials
export async function sendWelcomeEmail(
  to: string,
  ownerName: string,
  restaurantName: string,
  restaurantCode: string,
  staffPins?: { name: string; pin: string; role: string }[]
) {
  const staffTable = staffPins && staffPins.length > 0
    ? `<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:14px;">
        <thead><tr style="border-bottom:2px solid #E53935;"><th style="text-align:left;padding:8px;">Role</th><th style="text-align:left;padding:8px;">Name</th><th style="text-align:left;padding:8px;">PIN</th></tr></thead>
        <tbody>
          ${staffPins.map(s => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${s.role}</td><td style="padding:8px;">${s.name}</td><td style="padding:8px;font-family:monospace;color:#E53935;font-weight:bold;">${s.pin}</td></tr>`).join('')}
        </tbody>
       </table>`
    : '';

  await getResend().emails.send({
    from: "Softshape <noreply@softshape.in>",
    to,
    subject: `Welcome to Softshape — ${restaurantName} is live!`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Welcome, ${ownerName}!</h2>
        <p>Your restaurant <strong>${restaurantName}</strong> is now live on Softshape.</p>
        <p>Your restaurant code: <strong style="font-size:20px;letter-spacing:2px;">${restaurantCode}</strong></p>
        <p>Share this code with your staff so they can log in.</p>
        ${staffTable}
        <p style="margin-top:16px;"><a href="${process.env.FRONTEND_URL}" style="background:#E53935;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Open Dashboard</a></p>
      </div>
    `,
  });
}
