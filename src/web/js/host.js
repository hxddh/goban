/**
 * Host port: Native SDK bridge + localStorage (no game rules).
 */
(function (global) {
  function hasZero() {
    return typeof global.zero === "object" && global.zero != null;
  }

  function bytesToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToString(b64) {
    const raw = typeof b64 === "string" ? b64 : String(b64);
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function writeTextFile(path, text) {
    if (!hasZero()) throw new Error("no bridge");
    await global.zero.invoke("goban.writeTextFile", {
      path: path,
      b64: bytesToBase64(text),
    });
  }

  async function readTextFile(path) {
    if (!hasZero()) throw new Error("no bridge");
    const b64 = await global.zero.invoke("goban.readTextFile", { path: path });
    return base64ToString(b64);
  }

  async function saveFileDialog(options) {
    if (!hasZero() || !global.zero.dialogs || !global.zero.dialogs.saveFile) return null;
    return global.zero.dialogs.saveFile(options || {});
  }

  async function openFileDialog(options) {
    if (!hasZero() || !global.zero.dialogs || !global.zero.dialogs.openFile) return null;
    return global.zero.dialogs.openFile(options || {});
  }

  async function revealPath(path) {
    if (!hasZero() || !global.zero.os || !global.zero.os.revealPath) return;
    try {
      await global.zero.os.revealPath(path);
    } catch (_) {}
  }

  async function writeClipboard(text) {
    if (hasZero() && global.zero.clipboard && global.zero.clipboard.writeText) {
      await global.zero.clipboard.writeText(text);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy failed");
    } finally {
      document.body.removeChild(ta);
    }
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
  }

  function onDropFiles(handler) {
    if (!hasZero() || typeof global.zero.on !== "function") return function () {};
    try {
      return global.zero.on("drop:files", handler);
    } catch (_) {
      return function () {};
    }
  }

  function onAppLifecycle(handlers) {
    if (!hasZero() || typeof global.zero.on !== "function") return;
    try {
      if (handlers.deactivate) global.zero.on("app:deactivate", handlers.deactivate);
      if (handlers.activate) global.zero.on("app:activate", handlers.activate);
      if (handlers.shortcut) global.zero.on("shortcut", handlers.shortcut);
    } catch (_) {}
  }

  /** Normalize openFile / drop path lists to string paths. */
  function normalizePaths(input) {
    if (!input) return [];
    const arr = Array.isArray(input) ? input : [input];
    return arr
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.path === "string") return p.path;
        if (p && typeof p === "object" && typeof p.toString === "function") {
          const s = p.toString();
          return s && s !== "[object Object]" ? s : "";
        }
        return "";
      })
      .filter(Boolean);
  }

  global.GobanHost = {
    hasZero,
    bytesToBase64,
    writeTextFile,
    readTextFile,
    saveFileDialog,
    openFileDialog,
    revealPath,
    writeClipboard,
    storageGet,
    storageSet,
    storageRemove,
    onDropFiles,
    onAppLifecycle,
    normalizePaths,
  };
})(typeof window !== "undefined" ? window : globalThis);
