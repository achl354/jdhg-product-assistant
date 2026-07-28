// auth.js
//
// Basic-auth gate plus the startup rule: a production deployment must not be
// able to come up wide open by accident. The only way to run without
// credentials is the explicit ALLOW_UNAUTHENTICATED=true escape hatch, which
// is meant for local development, not for anything reachable off-box.
import crypto from "crypto";

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Pure decision function — no process.exit here, so it's unit-testable.
// Returns { ok: true } or { ok: false, message } for the caller to act on.
export function assertAuthConfigured({ user, pass, isProduction, allowUnauthenticated }) {
  const configured = Boolean(user) && Boolean(pass);
  if (configured) {
    return { ok: true };
  }
  if (!isProduction) {
    return { ok: true, warning: "BASIC_AUTH_USER/BASIC_AUTH_PASS not set — running with no access control (fine for local development only)." };
  }
  if (allowUnauthenticated) {
    return { ok: true, warning: "Running in production with NO ACCESS CONTROL because ALLOW_UNAUTHENTICATED=true is set. This should be a deliberate, temporary choice, never the default for anything reachable off-box." };
  }
  return {
    ok: false,
    message:
      "Refusing to start: NODE_ENV=production but BASIC_AUTH_USER/BASIC_AUTH_PASS are not both set. " +
      "Set both, or set ALLOW_UNAUTHENTICATED=true if you deliberately want this instance to run without access control."
  };
}

export function createBasicAuthMiddleware({ user, pass }) {
  return function basicAuth(req, res, next) {
    if (!user || !pass) return next();

    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");

    if (scheme === "Basic" && encoded) {
      const [reqUser, reqPass] = Buffer.from(encoded, "base64").toString().split(":");
      if (timingSafeEqual(reqUser || "", user) && timingSafeEqual(reqPass || "", pass)) {
        return next();
      }
    }

    res.set("WWW-Authenticate", 'Basic realm="JDHG Product Assistant"');
    res.status(401).send("Authentication required.");
  };
}
