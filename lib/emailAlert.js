// emailAlert.js
//
// Composes the downvote-alert email and decides whether alerting is active.
// Pure functions only — no nodemailer/network dependency here, so this stays
// unit-testable without a real SMTP account. server.js owns the actual
// transporter and the fire-and-forget sendMail() call.
export function isEmailAlertConfigured(env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.ALERT_EMAIL_TO);
}

export function buildDownvoteAlertEmail(entry, env) {
  const { timestamp, question, answer } = entry;

  const lines = [
    "A rep marked a JDHG Product Assistant reply as not helpful.",
    "",
    `Time: ${timestamp}`,
    "",
    "Question:",
    question,
    "",
    "Answer given:",
    answer
  ];

  if (env.APP_BASE_URL) {
    lines.push("", `Review all feedback: ${env.APP_BASE_URL}/admin/feedback`);
  }

  return {
    from: env.ALERT_EMAIL_FROM || env.SMTP_USER,
    to: env.ALERT_EMAIL_TO,
    subject: "JDHG Product Assistant — a reply was marked not helpful",
    text: lines.join("\n")
  };
}
