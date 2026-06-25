import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  restaurantName: string
) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  await resend.emails.send({
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
  restaurantCode: string
) {
  await resend.emails.send({
    from: "Softshape <noreply@softshape.in>",
    to,
    subject: `Welcome to Softshape — ${restaurantName} is live!`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Welcome, ${ownerName}!</h2>
        <p>Your restaurant <strong>${restaurantName}</strong> is now live on Softshape.</p>
        <p>Your restaurant code: <strong style="font-size:20px;letter-spacing:2px;">${restaurantCode}</strong></p>
        <p>Share this code with your staff so they can log in.</p>
        <p><a href="${process.env.FRONTEND_URL}" style="background:#E53935;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Open Dashboard</a></p>
      </div>
    `,
  });
}
