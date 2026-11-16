/* "A new version is out": the app is installed from GitHub releases, so nothing else tells people
 * about updates. Pure functions here (npm test); app.js fetches and draws. */
const VERSION_RE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/;

/** -1, 0 or 1. Semver-style: numeric parts as numbers, a pre-release below its release. */
function compareVersions(a, b) {
  const pa = VERSION_RE.exec(a), pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  const na = pa[1].split(".").map(Number), nb = pb[1].split(".").map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d) return Math.sign(d);
  }
  if (pa[2] && !pb[2]) return -1;
  if (!pa[2] && pb[2]) return 1;
  return 0;
}

/** The GitHub release if it is a published, newer version than the installed one, else null. */
function newerRelease(installed, release) {
  if (!installed || !release || release.draft || release.prerelease) return null;
  const tag = String(release.tag_name || "");
  if (!VERSION_RE.test(tag) || !VERSION_RE.test(installed)) return null;
  if (compareVersions(tag, installed) <= 0) return null;
  return { version: tag.replace(/^v/, ""), url: release.html_url };
}

if (typeof module !== "undefined") module.exports = { compareVersions, newerRelease };
