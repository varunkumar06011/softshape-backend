import { Resend } from "resend";

let resendInstance: Resend | null = null;

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
