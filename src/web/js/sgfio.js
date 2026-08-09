/**
 * SGF export side split out of app.js (v1.28): build / copy / save-dialog /
 * download, plus the browser fallbacks when the native host is absent.
 *
 * Only the export half lives here, and deliberately so: it merely READS the
 * finished game (history + a little metadata) and talks to the host. Import
 * stays in app.js because it rewrites the whole session — board, turn, clock,
 * swap2 phase, worker generation — and hauling that across a module boundary
 * would relocate the coupling, not remove it.
 * @module sgfio
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const Sgf = global.GobanSgf;
  const Host = global.GobanHost;

  /** deps: { getGame(): {history,result,mode,humanColor,originalStartedAt,ruleSet}, toast(msg) } */
  let deps = null;
  function init(d) { deps = d; }

  function buildSgf() {
    const g = deps.getGame();
    return Sgf.buildSgf({
      history: g.history,
      result: g.result,
      mode: g.mode,
      humanColor: g.humanColor,
      originalStartedAt: g.originalStartedAt,
      ruleSet: g.ruleSet,
    });
  }

  function fileName() {
    return Sgf.fileNameFromDate(deps.getGame().originalStartedAt);
  }

  function downloadBlob(sgf, name) {
    const blob = new Blob([sgf], { type: "application/x-go-sgf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function copyText(sgf) { await Host.writeClipboard(sgf); }

  /** Native save dialog when hosted; Blob download in a plain browser; clipboard as the last resort. */
  async function exportString(sgf, name) {
    const toast = deps.toast;
    if (Host.hasZero()) {
      try {
        const path = await Host.saveFileDialog({ title: t("export.title"), defaultName: name });
        if (path == null) { toast(t("export.cancelled")); return; }
        await Host.writeTextFile(path, sgf);
        await Host.revealPath(path);
        toast(t("export.done", { name: name }));
        return;
      } catch (e) {}
    }
    try {
      downloadBlob(sgf, name);
      toast(t("export.done", { name: name }));
    } catch (_) {
      try { await copyText(sgf); toast(t("export.toClipboard")); }
      catch (e2) { toast(t("export.fail")); }
    }
  }

  async function download() {
    if (!deps.getGame().history.length) { deps.toast(t("export.nothing")); return; }
    await exportString(buildSgf(), fileName());
  }

  async function copy() {
    if (!deps.getGame().history.length) { deps.toast(t("copy.nothing")); return; }
    try {
      await copyText(buildSgf());
      deps.toast(t("copy.done"));
    } catch (_) { deps.toast(t("copy.fail")); }
  }

  global.GobanSgfIo = { init, buildSgf, fileName, exportString, copyText, download, copy };
})(typeof window !== "undefined" ? window : globalThis);
