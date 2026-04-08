const nodemailer = require("nodemailer");

function getEmailProvider() {
  return (process.env.EMAIL_PROVIDER || "smtp").toLowerCase().trim();
}

function assertEmailConfig() {
  const provider = getEmailProvider();

  if (provider === "brevo" && !process.env.BREVO_API_KEY) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }

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

  if (!process.env.FROM_EMAIL) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }
}

function createTransporter() {
  const provider = getEmailProvider();

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

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
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

function normalizeRecipients(to) {
  return Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function sendViaBrevoApi(mailOptions, label) {
  const recipients = normalizeRecipients(mailOptions.to).map((email) => ({ email }));
  const payload = {
    sender: {
      email: process.env.FROM_EMAIL,
      name: "AgentCommerce",
    },
    to: recipients,
    subject: mailOptions.subject,
    htmlContent: mailOptions.html,
    textContent: stripHtml(mailOptions.html),
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    console.error(`[email:${label}] brevo-api-failed status=${res.status} body=${raw}`);
    throw new Error(`BREVO_API_ERROR_${res.status}`);
  }

  console.log(`[email:${label}] provider=brevo accepted=${JSON.stringify(recipients.map((r) => r.email))} response=${raw} messageId=${data.messageId || ""}`);
  return data;
}

async function sendMailWithLogging(mailOptions, label) {
  assertEmailConfig();

  if (getEmailProvider() === "brevo") {
    return sendViaBrevoApi(mailOptions, label);
  }

  const info = await getTransporter().sendMail({
    from: mailOptions.from,
    to: mailOptions.to,
    subject: mailOptions.subject,
    html: mailOptions.html,
  });

  console.log(`[email:${label}] provider=${getEmailProvider()} accepted=${JSON.stringify(info.accepted || [])} rejected=${JSON.stringify(info.rejected || [])} response=${info.response || ""} messageId=${info.messageId || ""}`);
  return info;
}

async function sendAdminEmail({ submission }) {
  const {
    id,
    storeUrl,
    platform,
    storeName,
    contactEmail,
    loginEmail,
    phoneNumber,
    hasPhysicalStore,
    storeAddress,
    plan,
    billingCycle,
    categories,
    deliveryMethods,
    returnPolicy,
    faqs,
    notes,
    qnaPairs,
    storeAnswers,
    fullDetails,
  } = submission;

  const cats = Array.isArray(categories) ? categories.join(", ") : categories || "-";
  const dels = Array.isArray(deliveryMethods) ? deliveryMethods.join(", ") : deliveryMethods || "-";
  const qaHtml = Array.isArray(qnaPairs) && qnaPairs.length
    ? qnaPairs
        .map((pair, index) => `
          <div style="padding:12px 0;border-top:1px solid rgba(255,255,255,0.06);">
            <div style="color:#a78bfa;font-size:12px;font-weight:700;margin-bottom:4px;">Q${index + 1}</div>
            <div style="color:#e2e8f0;font-size:13px;line-height:1.6;margin-bottom:8px;">${pair.question || "-"}</div>
            <div style="color:#94a3b8;font-size:12px;font-weight:700;margin-bottom:4px;">Answer</div>
            <div style="color:#cbd5e1;font-size:13px;line-height:1.6;">${pair.answer || "-"}</div>
          </div>
        `)
        .join("")
    : "<div style=\"color:#94a3b8;font-size:13px;\">No custom Q&A added.</div>";

  const answerRows = storeAnswers && typeof storeAnswers === "object"
    ? Object.entries(storeAnswers)
        .map(([key, value]) => `
          <tr>
            <td style="padding:10px 12px;background:#252535;border-radius:4px;color:#94a3b8;font-size:13px;font-weight:600;width:180px;">${key}</td>
            <td style="padding:10px 12px;color:#e2e8f0;font-size:13px;">${String(value || "-")}</td>
          </tr>
          <tr><td colspan="2" style="height:4px;"></td></tr>
        `)
        .join("")
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#0f0f14;color:#e2e8f0;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:28px 32px;">
    <h1 style="margin:0;color:#fff;font-size:22px;">New Store Integration Request</h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">Submission #${id} - Action required within 1-2 business days</p>
  </div>
  <div style="background:#1e1e2e;border:1px solid rgba(255,255,255,0.08);border-top:none;border-radius:0 0 12px 12px;padding:32px;">
    <h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 16px;">Store Details</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${[
        ["Store Name", storeName],
        ["Store URL", `<a href="${storeUrl}" style="color:#a78bfa;">${storeUrl}</a>`],
        ["Platform", String(platform || "").toUpperCase()],
        ["Store Contact Email", `<a href="mailto:${contactEmail}" style="color:#a78bfa;">${contactEmail}</a>`],
        ["Dashboard Login Email", loginEmail ? `<a href="mailto:${loginEmail}" style="color:#a78bfa;">${loginEmail}</a>` : "-"],
        ["Phone Number", phoneNumber || "-"],
        ["Plan", plan || "-"],
        ["Billing Cycle", billingCycle || "-"],
        ["Physical Store", hasPhysicalStore ? "Yes" : "No"],
        ["Address", storeAddress || "-"],
        ["Categories", cats],
        ["Delivery", dels],
      ].map(([k, v]) => `
        <tr>
          <td style="padding:10px 12px;background:#252535;border-radius:4px;color:#94a3b8;font-size:13px;font-weight:600;width:140px;">${k}</td>
          <td style="padding:10px 12px;color:#e2e8f0;font-size:13px;">${v}</td>
        </tr>
        <tr><td colspan="2" style="height:4px;"></td></tr>
      `).join("")}
    </table>
    ${answerRows ? `<h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Store Answers</h2><table style="width:100%;border-collapse:collapse;margin-bottom:24px;">${answerRows}</table>` : ""}
    ${returnPolicy ? `<h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Return Policy</h2><div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${returnPolicy.replace(/\n/g, "<br>")}</div>` : ""}
    ${faqs ? `<h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">FAQs</h2><div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${faqs.replace(/\n/g, "<br>")}</div>` : ""}
    ${notes ? `<h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Special Notes</h2><div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${notes.replace(/\n/g, "<br>")}</div>` : ""}
    <h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Custom Q&A</h2>
    <div style="background:#252535;border-radius:8px;padding:16px;font-size:13px;color:#cbd5e1;line-height:1.6;margin-bottom:20px;">${qaHtml}</div>
    ${fullDetails ? `<h2 style="color:#a78bfa;font-size:14px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Full Submission Copy</h2><pre style="white-space:pre-wrap;background:#111827;border-radius:8px;padding:16px;font-size:12px;color:#cbd5e1;line-height:1.65;overflow:auto;">${String(fullDetails)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>` : ""}
  </div>
</div>
</body>
</html>`;

  await sendMailWithLogging({
    from: `"AgentCommerce" <${process.env.FROM_EMAIL}>`,
    to: process.env.ADMIN_EMAIL || process.env.FROM_EMAIL,
    subject: `[New Submission #${id}] ${storeName} - ${platform} Integration Request`,
    html,
  }, "admin-notification");
}

async function sendConfirmationEmail({ to, storeName }) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:32px;">
    <h1 style="margin:0;color:#fff;font-size:24px;">Your AI Agent is On Its Way</h1>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:32px;">
    <p style="color:#475569;font-size:15px;line-height:1.7;">Thanks for submitting <strong>${storeName}</strong> to AgentCommerce.</p>
    <p style="color:#475569;font-size:15px;line-height:1.7;">Expected timeline: 1-2 business days.</p>
  </div>
</div>
</body>
</html>`;

  await sendMailWithLogging({
    from: `"AgentCommerce" <${process.env.FROM_EMAIL}>`,
    to,
    subject: `We got your request - ${storeName} AI agent incoming`,
    html,
  }, "customer-confirmation");
}

async function sendPasswordResetEmail({ to, temporaryPassword, loginUrl }) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:32px;">
    <h1 style="margin:0;color:#fff;font-size:24px;">Forgot Password Email</h1>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:32px;">
    <p style="color:#475569;font-size:15px;line-height:1.7;">This is your forgot password email for the AgentComerce customer dashboard.</p>
    <p style="color:#475569;font-size:15px;line-height:1.7;">Your temporary password is:</p>
    <div style="background:#f5f3ff;border-left:4px solid #7c3aed;border-radius:4px;padding:16px;margin:24px 0;font-size:18px;font-weight:700;color:#4c1d95;">${temporaryPassword}</div>
    <p style="color:#475569;font-size:14px;line-height:1.7;">Use this temporary password to sign in, then change it from your dashboard.</p>
    ${loginUrl ? `<p style="margin-top:20px;"><a href="${loginUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">Open Dashboard Login</a></p>` : ""}
    <p style="color:#64748b;font-size:13px;line-height:1.7;margin-top:20px;">If you did not request this reset, contact support immediately.</p>
  </div>
</div>
</body>
</html>`;

  await sendMailWithLogging({
    from: `"AgentCommerce" <${process.env.FROM_EMAIL}>`,
    to,
    subject: "AgentComerce forgot password email",
    html,
  }, "forgot-password");
}

async function sendInstallGuideEmail({ to, storeName, installGuide }) {
  const safeGuide = String(installGuide || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:620px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:32px;">
    <h1 style="margin:0;color:#fff;font-size:24px;">Install Guide for ${storeName}</h1>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:32px;">
    <p style="color:#475569;font-size:15px;line-height:1.7;">Your install guide is ready. Follow the details below for the next setup steps.</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px;font-size:14px;line-height:1.75;color:#334155;">${safeGuide}</div>
  </div>
</div>
</body>
</html>`;

  await sendMailWithLogging({
    from: `"AgentCommerce" <${process.env.FROM_EMAIL}>`,
    to,
    subject: `${storeName} install guide`,
    html,
  }, "install-guide");
}

module.exports = { sendAdminEmail, sendConfirmationEmail, sendPasswordResetEmail, sendInstallGuideEmail };
