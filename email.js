// ============================================================
// email.js — Transactional emails via Nodemailer
// Supports: SMTP, SendGrid, Postmark, Amazon SES
// ============================================================

const nodemailer = require("nodemailer");

function assertEmailConfig() {
  const provider = process.env.EMAIL_PROVIDER || "smtp";

  if (provider === "sendgrid" && !process.env.SENDGRID_API_KEY) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }

  if (provider === "postmark" && !process.env.POSTMARK_TOKEN) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }

  if (provider === "ses" && (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }

  if (provider === "smtp" && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }
}

// ── Transporter factory ───────────────────────────────────────
function createTransporter() {
  assertEmailConfig();
  const provider = process.env.EMAIL_PROVIDER || "smtp";

  if (provider === "sendgrid") {
    return nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 465,
      secure: true,
      auth: { user: "apikey", pass: process.env.SENDGRID_API_KEY },
    });
  }

  if (provider === "postmark") {
    return nodemailer.createTransport({
      host: "smtp.postmarkapp.com",
      port: 587,
      auth: { user: process.env.POSTMARK_TOKEN, pass: process.env.POSTMARK_TOKEN },
    });
  }

  if (provider === "ses") {
    const aws = require("@aws-sdk/client-ses");
    const sesClient = new aws.SES({ region: process.env.AWS_REGION || "us-east-1" });
    return nodemailer.createTransport({ SES: { ses: sesClient, aws } });
  }

  // Default: generic SMTP
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || "smtp.mailtrap.io",
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
}

// ── Admin notification ────────────────────────────────────────
async function sendAdminEmail({ submission }) {
  const {
    id, storeUrl, platform, storeName, contactEmail,
    categories, deliveryMethods, returnPolicy, faqs, notes,
  } = submission;

  const cats = Array.isArray(categories) ? categories.join(", ") : categories || "—";
  const dels = Array.isArray(deliveryMethods) ? deliveryMethods.join(", ") : deliveryMethods || "—";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#0f0f14;color:#e2e8f0;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;">

  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:28px 32px;">
    <h1 style="margin:0;color:#fff;font-size:22px;">🤖 New Store Integration Request</h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">Submission #${id} — Action required within 1–2 business days</p>
  </div>

  <div style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.08);border-top:none;border-radius:0 0 12px 12px;padding:32px;">

    <h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 16px;">Store Details</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${[
        ["Store Name",   storeName],
        ["Store URL",    `<a href="${storeUrl}" style="color:#a78bfa;">${storeUrl}</a>`],
        ["Platform",     platform?.toUpperCase()],
        ["Contact",      `<a href="mailto:${contactEmail}" style="color:#a78bfa;">${contactEmail}</a>`],
        ["Categories",   cats],
        ["Delivery",     dels],
      ].map(([k, v]) => `
        <tr>
          <td style="padding:10px 12px;background:#252535;border-radius:4px;color:#94a3b8;font-size:13px;font-weight:600;width:140px;">${k}</td>
          <td style="padding:10px 12px;color:#e2e8f0;font-size:13px;">${v}</td>
        </tr>
        <tr><td colspan="2" style="height:4px;"></td></tr>
      `).join("")}
    </table>

    ${returnPolicy ? `
    <h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Return Policy</h2>
    <div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${returnPolicy.replace(/\n/g, "<br>")}</div>
    ` : ""}

    ${faqs ? `
    <h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">FAQs</h2>
    <div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${faqs.replace(/\n/g, "<br>")}</div>
    ` : ""}

    ${notes ? `
    <h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Special Notes</h2>
    <div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${notes.replace(/\n/g, "<br>")}</div>
    ` : ""}

    <div style="background:#1a1a2e;border:1px solid #7c3aed33;border-radius:8px;padding:16px;margin-top:8px;">
      <p style="margin:0;font-size:12px;color:#64748b;">⚠️ API credentials are stored encrypted. Access them via the admin dashboard. Do not share submission emails publicly.</p>
    </div>

  </div>
</div>
</body>
</html>`;

  await getTransporter().sendMail({
    from:    `"AgentCommerce" <${process.env.FROM_EMAIL || "noreply@agentcommerce.ai"}>`,
    to:      process.env.ADMIN_EMAIL || "admin@agentcommerce.ai",
    subject: `[New Submission #${id}] ${storeName} — ${platform} Integration Request`,
    html,
  });
}

// ── Customer confirmation ─────────────────────────────────────
async function sendConfirmationEmail({ to, storeName }) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;">

  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:32px;">
    <h1 style="margin:0;color:#fff;font-size:24px;">Your AI Agent is On Its Way! 🚀</h1>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:32px;">
    <p style="color:#475569;font-size:15px;line-height:1.7;">Hi there,</p>
    <p style="color:#475569;font-size:15px;line-height:1.7;">
      Thanks for submitting <strong>${storeName}</strong> to AgentCommerce. We've received your store details and our team is already on it!
    </p>

    <div style="background:#f5f3ff;border-left:4px solid #7c3aed;border-radius:4px;padding:16px;margin:24px 0;">
      <p style="margin:0;color:#4c1d95;font-size:14px;font-weight:600;">⏱ Expected timeline: 1–2 business days</p>
    </div>

    <h3 style="color:#1e1b4b;font-size:15px;">What happens next:</h3>
    <div style="space-y:8px;">
      ${[
        ["🔍", "We review your credentials and configure your AI agent"],
        ["🧠", "We train it on your products, FAQs, and store policies"],
        ["⚡", "We install the widget snippet in your store"],
        ["✅", "You receive confirmation and your agent goes live!"],
      ].map(([emoji, text]) => `
        <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <span style="font-size:18px;">${emoji}</span>
          <p style="margin:0;color:#475569;font-size:14px;line-height:1.6;">${text}</p>
        </div>
      `).join("")}
    </div>

    <p style="color:#475569;font-size:14px;line-height:1.7;margin-top:24px;">
      If you have any questions in the meantime, reply to this email or reach us at 
      <a href="mailto:support@agentcommerce.ai" style="color:#7c3aed;">support@agentcommerce.ai</a>.
    </p>

    <p style="color:#94a3b8;font-size:13px;margin-top:32px;padding-top:20px;border-top:1px solid #f1f5f9;">
      — The AgentCommerce Team<br/>
      <a href="https://agentcommerce.ai" style="color:#7c3aed;">agentcommerce.ai</a>
    </p>
  </div>
</div>
</body>
</html>`;

  await getTransporter().sendMail({
    from:    `"AgentCommerce" <${process.env.FROM_EMAIL || "noreply@agentcommerce.ai"}>`,
    to,
    subject: `✅ We got your request — ${storeName} AI agent incoming!`,
    html,
  });
}

async function sendPasswordResetEmail({ to, temporaryPassword, loginUrl }) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:32px;">
    <h1 style="margin:0;color:#fff;font-size:24px;">Password Reset</h1>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:32px;">
    <p style="color:#475569;font-size:15px;line-height:1.7;">A password reset was requested for your AgentCommerce customer dashboard.</p>
    <p style="color:#475569;font-size:15px;line-height:1.7;">Your temporary password is:</p>
    <div style="background:#f5f3ff;border-left:4px solid #7c3aed;border-radius:4px;padding:16px;margin:24px 0;font-size:18px;font-weight:700;color:#4c1d95;">${temporaryPassword}</div>
    <p style="color:#475569;font-size:14px;line-height:1.7;">Use this temporary password to sign in, then change it from your dashboard.</p>
    ${loginUrl ? `<p style="margin-top:20px;"><a href="${loginUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">Open Dashboard Login</a></p>` : ""}
    <p style="color:#64748b;font-size:13px;line-height:1.7;margin-top:20px;">If you did not request this reset, contact support immediately.</p>
  </div>
</div>
</body>
</html>`;

  await getTransporter().sendMail({
    from: `"AgentCommerce" <${process.env.FROM_EMAIL || "noreply@agentcommerce.ai"}>`,
    to,
    subject: "AgentCommerce dashboard password reset",
    html,
  });
}

module.exports = { sendAdminEmail, sendConfirmationEmail, sendPasswordResetEmail };
