/**
 * Named save slots: localStorage-backed store + list rendering.
 * Game-flow glue (load/delete confirmations, applying snapshots) stays in
 * app.js — this module owns persistence and the DOM list only.
 * @module slots
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const Host = global.GobanHost;
  const SLOTS_KEY = "goban.v12.slots";
  const SLOTS_MAX = 30;

  function load() {
    try {
      const raw = Host.storageGet(SLOTS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s) => s && s.snap) : [];
    } catch (_) {
      return [];
    }
  }

  /** @returns {boolean} false when the write failed (e.g. storage quota). */
  function persist(arr) {
    // Host.storageSet already swallows QuotaExceeded and returns false —
    // do not treat a false return as success (that regenerated the v1.23
    // "已保存" lie after the toast was fixed to check this boolean).
    return !!Host.storageSet(SLOTS_KEY, JSON.stringify(arr.slice(0, SLOTS_MAX)));
  }

  function resultLabel(r) {
    return t(r === "b" ? "result.blackWin" : r === "w" ? "result.whiteWin" : r === "draw" ? "result.draw" : "result.playing");
  }

  function slotDate(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function metaText(snap) {
    const moves = (snap.history && snap.history.length) || 0;
    return t("slots.meta", { result: resultLabel(snap.result), moves: moves, when: slotDate(snap.savedAt) });
  }

  function genId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  /** Prepend a new named slot for `snap`. @returns {boolean} persisted ok. */
  function add(snap) {
    const arr = load();
    arr.unshift({
      id: genId(),
      name: t("slots.defaultName", { n: slotDate(Date.now()) }),
      savedAt: Date.now(),
      snap,
    });
    return persist(arr);
  }

  function get(id) {
    return load().find((s) => s.id === id) || null;
  }

  function remove(id) {
    return persist(load().filter((s) => s.id !== id));
  }

  /** @returns {boolean} false when missing id or persist failed. */
  function rename(id, name) {
    const arr = load();
    const slot = arr.find((s) => s.id === id);
    if (!slot) return false;
    const clean = (name || "").trim().slice(0, 40);
    slot.name = clean || t("slots.defaultName", { n: slotDate(slot.savedAt) });
    return persist(arr);
  }

  /** Rebuild #slots-list rows (+#slots-empty visibility) from the store. */
  function render() {
    const list = document.getElementById("slots-list");
    const empty = document.getElementById("slots-empty");
    if (!list) return;
    const arr = load();
    if (empty) empty.hidden = arr.length > 0;
    list.innerHTML = "";
    for (const slot of arr) {
      const row = document.createElement("div");
      row.className = "slot-row";
      row.dataset.id = slot.id;
      const nameEl = document.createElement("input");
      nameEl.className = "slot-name";
      nameEl.value = slot.name;
      nameEl.maxLength = 40;
      nameEl.setAttribute("aria-label", t("slots.nameLabel"));
      const meta = document.createElement("div");
      meta.className = "slot-meta";
      meta.textContent = metaText(slot.snap);
      const ops = document.createElement("div");
      ops.className = "slot-ops";
      // 这两个按钮原本是 innerHTML 拼出来的字面量「读取」「删除」，没走 t() ——
      // 于是英文界面下的存档列表里坐着两个中文按钮（实测：界面 lang=en、存档名
      // 正确地是 "Game 08-04 00:34"，按钮却是「读取」「删除」）。防这件事的闸门
      // 没响，因为它的正则只认双引号，而这两行是单引号。
      // 顺手改成 createElement + textContent：id 不再拼进 HTML 串。
      for (const spec of [
        { cls: "text-link slot-load", key: "slots.load" },
        { cls: "text-link danger slot-del", key: "slots.del" },
      ]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = spec.cls;
        btn.dataset.id = slot.id;
        btn.textContent = t(spec.key);
        ops.appendChild(btn);
      }
      row.appendChild(nameEl);
      row.appendChild(meta);
      row.appendChild(ops);
      list.appendChild(row);
    }
  }

  /**
   * The slot a further `add` would silently destroy, or null while there is
   * room. `add` prepends and `persist` slices to SLOTS_MAX, so saving a 31st
   * game deletes the oldest one — measured: the list stayed at 30, the oldest
   * went from 「第1个」 to 「第2个」, `add` returned true, and the app toasted
   * 「已保存」. These are saves the user named by hand; the app asks before
   * clearing 存档 and before restoring a backup, and this is the same kind of
   * act. Callers use this to ask first.
   */
  function wouldEvict() {
    const arr = load();
    return arr.length >= SLOTS_MAX ? arr[arr.length - 1] : null;
  }

  global.GobanSlots = { load, add, get, remove, rename, render, wouldEvict, MAX: SLOTS_MAX };
})(typeof window !== "undefined" ? window : globalThis);
