/**
 * The app version, in one place.
 *
 * Hand-kept, like app.zon's — but scripts/test-game.mjs asserts the two are
 * equal, so a bump that misses one fails the build. That guard exists because
 * the literal that used to live inside sgf.js drifted unnoticed: v1.26.0
 * exported 棋谱 stamped 1.25.3, and v1.25.0 shipped an installer stamped
 * 1.24.0. Anything that needs to show or record the version reads it here.
 * @module version
 */
(function (global) {
  global.GOBAN_VERSION = "1.32.0";
})(typeof window !== "undefined" ? window : globalThis);
