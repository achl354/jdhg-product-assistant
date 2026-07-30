import { test } from "node:test";
import assert from "node:assert/strict";

import { isEmailAlertConfigured, buildDownvoteAlertEmail } from "../lib/emailAlert.js";

const FULL_ENV = {
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "bot@example.com",
  SMTP_PASS: "secret",
  ALERT_EMAIL_TO: "andrew@example.com"
};

test("isEmailAlertConfigured is true when all required vars are set", () => {
  assert.equal(isEmailAlertConfigured(FULL_ENV), true);
});

test("isEmailAlertConfigured is false when any single required var is missing", () => {
  for (const key of Object.keys(FULL_ENV)) {
    const env = { ...FULL_ENV, [key]: undefined };
    assert.equal(isEmailAlertConfigured(env), false, `expected false with ${key} missing`);
  }
});

test("isEmailAlertConfigured is false for an empty environment", () => {
  assert.equal(isEmailAlertConfigured({}), false);
});

test("buildDownvoteAlertEmail composes to/subject/text from the feedback entry", () => {
  const entry = {
    timestamp: "2026-07-30T01:00:00.000Z",
    question: "Does EasiMove PRO have an ARTG number?",
    answer: "Not confirmed for PRO specifically."
  };
  const email = buildDownvoteAlertEmail(entry, FULL_ENV);

  assert.equal(email.to, "andrew@example.com");
  assert.equal(email.from, "bot@example.com");
  assert.match(email.subject, /not helpful/);
  assert.match(email.text, /2026-07-30T01:00:00\.000Z/);
  assert.match(email.text, /Does EasiMove PRO have an ARTG number\?/);
  assert.match(email.text, /Not confirmed for PRO specifically\./);
});

test("buildDownvoteAlertEmail uses ALERT_EMAIL_FROM over SMTP_USER when set", () => {
  const entry = { timestamp: "t", question: "q", answer: "a" };
  const env = { ...FULL_ENV, ALERT_EMAIL_FROM: "alerts@jdhealthcare.com.au" };
  const email = buildDownvoteAlertEmail(entry, env);
  assert.equal(email.from, "alerts@jdhealthcare.com.au");
});

test("buildDownvoteAlertEmail omits the admin/feedback link when APP_BASE_URL is not set", () => {
  const entry = { timestamp: "t", question: "q", answer: "a" };
  const email = buildDownvoteAlertEmail(entry, FULL_ENV);
  assert.doesNotMatch(email.text, /admin\/feedback/);
});

test("buildDownvoteAlertEmail includes a clickable admin/feedback link when APP_BASE_URL is set", () => {
  const entry = { timestamp: "t", question: "q", answer: "a" };
  const env = { ...FULL_ENV, APP_BASE_URL: "https://jdhg-assistant.onrender.com" };
  const email = buildDownvoteAlertEmail(entry, env);
  assert.match(email.text, /Review all feedback: https:\/\/jdhg-assistant\.onrender\.com\/admin\/feedback/);
});
