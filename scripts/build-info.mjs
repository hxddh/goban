/**
 * Stamp the toolchain into the packaged app: frontend/dist/build-info.json.
 *
 * Why this exists — v1.45.1. The Windows build broke with
 * `lld-link: undefined symbol: createWindowsGpuRenderer()`, and nothing in the
 * artifact said which SDK had produced it. `package-manifest.zon` records
 * artifact / target / version / app_id / executable / optimize / web_engine /
 * web_layer / signing / subsystem / asset_count / frontend / capabilities —
 * and no SDK version. CI installs `@native-sdk/cli` unpinned (deliberately:
 * every build takes the current release), so "which SDK" is a fact about the
 * *moment of the build* that only the build can record. Finding it took a
 * bisect over published npm versions; this file makes the next one a `cat`.
 *
 * It ships inside the package (macOS: Goban.app/Contents/Resources/frontend/
 * dist/, Windows: Goban/resources/frontend/dist/) because that is where an
 * end user's broken installer can still be interrogated.
 *
 * No runtime code reads it — deliberately. The browser regression serves
 * src/web, where this file does not exist, so anything that read it would
 * have to be written twice and could drift.
 *
 * Usage: node scripts/build-info.mjs [distDir]
 *   NATIVE_SDK_PATH / SDK_PATH — the SDK's install root, if known.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.argv[2] || path.join(root, "frontend", "dist");

/** Never fail the build for a missing probe: a stamp with a hole in it still
 *  beats no stamp, and this script runs between sync and `zig build`. */
function quiet(fn) {
  try {
    return fn();
  } catch (_) {
    return null;
  }
}

const sdkPath = process.env.NATIVE_SDK_PATH || process.env.SDK_PATH || "";
const sdk =
  (sdkPath &&
    quiet(() => JSON.parse(fs.readFileSync(path.join(sdkPath, "package.json"), "utf8")).version)) ||
  quiet(() =>
    JSON.parse(
      execFileSync("npm", ["ls", "-g", "@native-sdk/cli", "--json", "--depth", "0"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    ).dependencies["@native-sdk/cli"].version
  ) ||
  null;

// app.zon is .zon, not JSON — one field, one regex, no parser.
const appZon = quiet(() => fs.readFileSync(path.join(root, "app.zon"), "utf8")) || "";
const version = (appZon.match(/\.version\s*=\s*"([^"]+)"/) || [])[1] || null;

const info = {
  app: version,
  sdk,
  zig: quiet(() => execFileSync("zig", ["version"], { encoding: "utf8" }).trim()),
  node: process.versions.node,
  commit: quiet(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()),
  platform: process.env.BUILD_TARGET || process.platform,
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
console.log("build-info: " + JSON.stringify(info));
