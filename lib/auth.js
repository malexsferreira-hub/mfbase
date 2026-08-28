// Auth helpers — pure Node core (crypto), no dependencies. Kept isolated so the
// security-critical bits (token derivation + comparison) are easy to unit-test
// on their own, separate from Express/pg wiring.
const crypto = require("crypto");

const COOKIE_NAME = "mfbase_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

function sessionToken(secret) {
  return crypto.createHmac("sha256", secret).update("mfbase-authenticated-v1").digest("hex");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach(function (part) {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthenticated(cookieHeader, secret) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  return safeEqual(token, sessionToken(secret));
}

function setCookieHeader(secret, opts) {
  opts = opts || {};
  const token = sessionToken(secret);
  const parts = [
    COOKIE_NAME + "=" + encodeURIComponent(token),
    "Max-Age=" + MAX_AGE_SECONDS,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader() {
  return COOKIE_NAME + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
}

function checkPassword(candidate, appPassword) {
  return safeEqual(String(candidate || ""), String(appPassword || ""));
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  isAuthenticated,
  setCookieHeader,
  clearCookieHeader,
  checkPassword,
  sessionToken,
  safeEqual,
};
