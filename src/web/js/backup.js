/**
 * Whole-app backup: every stored key in one file, and back again.
 *
 * Until v1.31 the only way anything left this app was 棋谱 export, one game
 * at a time. Backing up 30 存档 meant 30 载入→导出 cycles, and 对局统计,
 * 每日打卡连胜 and 练习进度/错题本 had no exit at all — a reinstall or a new
 * machine started from zero.
 *
 * Pure over an injected storage object so it is testable without a DOM; the
 * app passes GobanHost.
 * @module backup
 */
(function (global) {
  /** Every key the app owns. Anything absent from storage is simply skipped. */
  const KEYS = [
    "goban.v12.save",
    "goban.v12.slots",
    "goban.v12.stats",
    "goban.v12.totals",
    "goban.v12.daily",
    "goban.v12.practice",
    "goban.v12.lang",
  ];

  const FORMAT = "goban-backup";
  /** Bump only for a breaking change to the envelope, not to the payloads. */
  const FORMAT_VERSION = 1;

  /**
   * @param {{storageGet:(k:string)=>string|null}} store
   * @returns {object} the envelope, ready for JSON.stringify
   */
  function build(store) {
    const data = {};
    for (const k of KEYS) {
      const v = store.storageGet(k);
      if (typeof v === "string" && v.length) data[k] = v;
    }
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      app: global.GOBAN_VERSION || "0.0.0",
      savedAt: Date.now(),
      data: data,
    };
  }

  function serialize(store) {
    return JSON.stringify(build(store), null, 2);
  }

  /**
   * Validate without touching storage. Returns {ok, error, keys, app}.
   *
   * Deliberately strict about the envelope and deliberately lax about the
   * payloads: each module already parses its own key defensively (a corrupt
   * value yields an empty list, never a crash), so re-validating their shapes
   * here would just be a second place to keep in sync.
   */
  function inspect(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: "parse" };
    }
    if (!obj || typeof obj !== "object" || obj.format !== FORMAT) {
      return { ok: false, error: "format" };
    }
    if (!(obj.formatVersion <= FORMAT_VERSION)) return { ok: false, error: "version" };
    if (!obj.data || typeof obj.data !== "object") return { ok: false, error: "format" };
    const keys = Object.keys(obj.data).filter(
      (k) => KEYS.indexOf(k) >= 0 && typeof obj.data[k] === "string"
    );
    if (!keys.length) return { ok: false, error: "empty" };
    return { ok: true, keys: keys, app: obj.app || "", savedAt: obj.savedAt || 0, obj: obj };
  }

  /**
   * Replace stored state with the backup's. Keys the file does not carry are
   * REMOVED, not left behind: a half-restored profile (someone else's 存档
   * beside your 统计) is worse than either state on its own.
   * @returns {{ok:boolean, error?:string, restored?:number}}
   */
  function restore(store, text) {
    const chk = inspect(text);
    if (!chk.ok) return chk;
    for (const k of KEYS) {
      if (chk.keys.indexOf(k) >= 0) store.storageSet(k, chk.obj.data[k]);
      else store.storageRemove(k);
    }
    return { ok: true, restored: chk.keys.length };
  }

  function fileName(ts) {
    const d = new Date(typeof ts === "number" ? ts : Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return (
      "goban-backup-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ".json"
    );
  }

  global.GobanBackup = { KEYS, FORMAT, FORMAT_VERSION, build, serialize, inspect, restore, fileName };
})(typeof window !== "undefined" ? window : globalThis);
