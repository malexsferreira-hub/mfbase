// Plain-Node smoke test for lib/auth.js — no test framework dependency needed.
const assert = require("assert");
const auth = require("./auth");

// checkPassword: correct vs wrong vs empty
assert.strictEqual(auth.checkPassword("hunter2", "hunter2"), true, "correct password should match");
assert.strictEqual(auth.checkPassword("wrong", "hunter2"), false, "wrong password should not match");
assert.strictEqual(auth.checkPassword("", "hunter2"), false, "empty password should not match");
assert.strictEqual(auth.checkPassword(undefined, "hunter2"), false, "undefined password should not match");
console.log("PASS: checkPassword matches/rejects correctly");

// cookie round-trip: set then verify with the same secret
const secret = "test-secret-abc";
const cookieHeaderSet = auth.setCookieHeader(secret, { secure: false });
assert.ok(cookieHeaderSet.indexOf("mfbase_session=") === 0, "cookie header should start with the cookie name");
assert.ok(cookieHeaderSet.indexOf("HttpOnly") >= 0, "cookie should be HttpOnly");
assert.ok(cookieHeaderSet.indexOf("Secure") === -1, "cookie should omit Secure when secure:false");

// simulate the browser sending that cookie back
const cookieValue = cookieHeaderSet.split(";")[0]; // "mfbase_session=<token>"
assert.strictEqual(auth.isAuthenticated(cookieValue, secret), true, "a freshly-issued cookie should authenticate");
console.log("PASS: cookie issued by setCookieHeader authenticates via isAuthenticated");

// wrong secret should NOT authenticate (simulates a forged/old cookie)
assert.strictEqual(auth.isAuthenticated(cookieValue, "different-secret"), false, "cookie signed with a different secret should not authenticate");
console.log("PASS: cookie signed with the wrong secret is rejected");

// missing cookie
assert.strictEqual(auth.isAuthenticated("", secret), false, "no cookie header should not authenticate");
assert.strictEqual(auth.isAuthenticated("other=1; foo=bar", secret), false, "unrelated cookies should not authenticate");
console.log("PASS: missing/unrelated cookies are rejected");

// multiple cookies in header, ours present among others
const multi = "foo=bar; " + cookieValue + "; baz=qux";
assert.strictEqual(auth.isAuthenticated(multi, secret), true, "our cookie should be found among other cookies");
console.log("PASS: cookie is found correctly when mixed with other cookies");

// tampered token should fail
const tampered = "mfbase_session=deadbeef00000000000000000000000000000000000000000000000000000000";
assert.strictEqual(auth.isAuthenticated(tampered, secret), false, "a tampered/garbage token should not authenticate");
console.log("PASS: tampered token is rejected");

// clearCookieHeader looks sane
const cleared = auth.clearCookieHeader();
assert.ok(cleared.indexOf("Max-Age=0") >= 0, "clear cookie should expire immediately");
console.log("PASS: clearCookieHeader expires the cookie");

console.log("\nALL AUTH UNIT TESTS PASSED");
