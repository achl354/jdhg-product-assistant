import { test } from "node:test";
import assert from "node:assert/strict";

import { validateChatRequest, MAX_MESSAGE_LENGTH, MAX_HISTORY_MESSAGES } from "../lib/requestValidation.js";

test("accepts a minimal valid request (message only)", () => {
  assert.equal(validateChatRequest({ message: "Hello" }), null);
});

test("accepts a valid request with well-formed history", () => {
  const body = {
    message: "Hello",
    history: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  };
  assert.equal(validateChatRequest(body), null);
});

test("rejects a non-object body", () => {
  assert.match(validateChatRequest(null), /JSON object/);
  assert.match(validateChatRequest("hello"), /JSON object/);
  assert.match(validateChatRequest([]), /JSON object/);
});

test("rejects a missing or empty message", () => {
  assert.match(validateChatRequest({}), /message is required/);
  assert.match(validateChatRequest({ message: "" }), /message is required/);
  assert.match(validateChatRequest({ message: "   " }), /message is required/);
  assert.match(validateChatRequest({ message: 42 }), /message is required/);
});

test("rejects a message longer than the configured limit", () => {
  const body = { message: "a".repeat(MAX_MESSAGE_LENGTH + 1) };
  assert.match(validateChatRequest(body), /exceeds the/);
});

test("rejects history that isn't an array", () => {
  assert.match(validateChatRequest({ message: "hi", history: "not an array" }), /history must be an array/);
});

test("rejects history longer than the configured limit", () => {
  const history = Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => ({ role: "user", content: "x" }));
  assert.match(validateChatRequest({ message: "hi", history }), /history exceeds/);
});

test("rejects a history entry with a malformed role (HTTP-400-worthy)", () => {
  const history = [{ role: "system", content: "not allowed" }];
  assert.match(validateChatRequest({ message: "hi", history }), /role must be "user" or "assistant"/);
});

test("rejects a history entry with non-string content", () => {
  const history = [{ role: "user", content: { nested: true } }];
  assert.match(validateChatRequest({ message: "hi", history }), /content must be a string/);
});

test("rejects a history entry with content over the length limit", () => {
  const history = [{ role: "user", content: "a".repeat(MAX_MESSAGE_LENGTH + 1) }];
  assert.match(validateChatRequest({ message: "hi", history }), /exceeds the/);
});

test("rejects a history entry with unexpected extra fields", () => {
  const history = [{ role: "user", content: "hi", name: "injected", extra: 1 }];
  assert.match(validateChatRequest({ message: "hi", history }), /unexpected field/);
});

test("rejects a history entry that isn't an object", () => {
  const history = ["just a string"];
  assert.match(validateChatRequest({ message: "hi", history }), /must be an object/);
});
