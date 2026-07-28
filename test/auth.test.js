import { test } from "node:test";
import assert from "node:assert/strict";

import { assertAuthConfigured, createBasicAuthMiddleware, timingSafeEqual } from "../lib/auth.js";

test("timingSafeEqual matches equal strings and rejects unequal ones", () => {
  assert.equal(timingSafeEqual("secret", "secret"), true);
  assert.equal(timingSafeEqual("secret", "different"), false);
  assert.equal(timingSafeEqual("short", "muchlonger"), false);
});

test("assertAuthConfigured: ok when both credentials are set", () => {
  const result = assertAuthConfigured({ user: "rep", pass: "hunter2", isProduction: true, allowUnauthenticated: false });
  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined);
});

test("assertAuthConfigured: ok with a warning in non-production when unconfigured", () => {
  const result = assertAuthConfigured({ user: undefined, pass: undefined, isProduction: false, allowUnauthenticated: false });
  assert.equal(result.ok, true);
  assert.match(result.warning, /no access control/i);
});

test("assertAuthConfigured: fails startup in production when unconfigured and no override", () => {
  const result = assertAuthConfigured({ user: undefined, pass: undefined, isProduction: true, allowUnauthenticated: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to start/);
  assert.match(result.message, /production/);
});

test("assertAuthConfigured: production is only unauthenticated via explicit ALLOW_UNAUTHENTICATED override", () => {
  const result = assertAuthConfigured({ user: undefined, pass: undefined, isProduction: true, allowUnauthenticated: true });
  assert.equal(result.ok, true);
  assert.match(result.warning, /NO ACCESS CONTROL/);
});

test("assertAuthConfigured: fails if only one of user/pass is set", () => {
  const result = assertAuthConfigured({ user: "rep", pass: undefined, isProduction: true, allowUnauthenticated: false });
  assert.equal(result.ok, false);
});

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

test("basic auth middleware passes through when not configured", () => {
  const middleware = createBasicAuthMiddleware({ user: undefined, pass: undefined });
  let nextCalled = false;
  middleware({ headers: {} }, makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("basic auth middleware rejects a request with no Authorization header", () => {
  const middleware = createBasicAuthMiddleware({ user: "rep", pass: "hunter2" });
  const res = makeRes();
  let nextCalled = false;
  middleware({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("basic auth middleware rejects wrong credentials", () => {
  const middleware = createBasicAuthMiddleware({ user: "rep", pass: "hunter2" });
  const res = makeRes();
  const wrongEncoded = Buffer.from("rep:wrongpass").toString("base64");
  let nextCalled = false;
  middleware({ headers: { authorization: `Basic ${wrongEncoded}` } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("basic auth middleware accepts correct credentials", () => {
  const middleware = createBasicAuthMiddleware({ user: "rep", pass: "hunter2" });
  const res = makeRes();
  const encoded = Buffer.from("rep:hunter2").toString("base64");
  let nextCalled = false;
  middleware({ headers: { authorization: `Basic ${encoded}` } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});
