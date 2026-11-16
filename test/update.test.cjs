// node --test test/  — the "new release" notice decides on a version comparison, so pin it down.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, newerRelease } = require("../www/update.js");

test("numeric parts compare as numbers, not strings", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.4.2", "0.4.2"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("a pre-release is older than its release and newer than the one before", () => {
  assert.equal(compareVersions("0.5.0-profile-test", "0.5.0"), -1);
  assert.equal(compareVersions("0.5.0-profile-test", "0.4.2"), 1);
});

test("newerRelease reads GitHub tags with or without the v", () => {
  assert.equal(newerRelease("0.4.1", { tag_name: "v0.4.2", html_url: "u" })?.version, "0.4.2");
  assert.equal(newerRelease("0.4.2", { tag_name: "v0.4.2", html_url: "u" }), null);
  assert.equal(newerRelease("0.5.0-profile-test", { tag_name: "v0.4.2", html_url: "u" }), null);
  assert.equal(newerRelease("0.4.1", { tag_name: "0.4.2", html_url: "u" })?.url, "u");
});

test("drafts, pre-releases and junk never trigger the notice", () => {
  assert.equal(newerRelease("0.4.1", { tag_name: "v0.9.0", draft: true, html_url: "u" }), null);
  assert.equal(newerRelease("0.4.1", { tag_name: "v0.9.0", prerelease: true, html_url: "u" }), null);
  assert.equal(newerRelease("0.4.1", { tag_name: "latest", html_url: "u" }), null);
  assert.equal(newerRelease("0.4.1", null), null);
  assert.equal(newerRelease(undefined, { tag_name: "v0.9.0", html_url: "u" }), null);
});
