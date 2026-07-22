/**
 * Named save slots: localStorage-backed store + list rendering.
 * Game-flow glue (load/delete confirmations, applying snapshots) stays in
 * app.js — this module owns persistence and the DOM list only.
 * @module slots
 */
(function (global) {
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
    try {
      Host.storageSet(SLOTS_KEY, JSON.stringify(arr.slice(0, SLOTS_MAX)));
      return true;
    } catch (_) {
      return false;
    }
  }

  function resultLabel(r) {
    return r === "b" ? "黑胜" : r === "w" ? "白胜" : r === "draw" ? "平局" : "进行中";
  }

  function slotDate(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function metaText(snap) {
    const moves = (snap.history && snap.history.length) || 0;
    return moves + "手 · " + resultLabel(snap.result) + " · " + slotDate(snap.savedAt);
  }

  function genId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  /** Prepend a new named slot for `snap`. @returns {boolean} persisted ok. */
  function add(snap) {
    const arr = load();
    arr.unshift({ id: genId(), name: "对局 " + slotDate(Date.now()), savedAt: Date.now(), snap });
    return persist(arr);
  }

  function get(id) {
    return load().find((s) => s.id === id) || null;
  }

  function remove(id) {
    return persist(load().filter((s) => s.id !== id));
  }

  function rename(id, name) {
    const arr = load();
    const slot = arr.find((s) => s.id === id);
    if (!slot) return;
    const clean = (name || "").trim().slice(0, 40);
    slot.name = clean || ("对局 " + slotDate(slot.savedAt));
    persist(arr);
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
      nameEl.setAttribute("aria-label", "存档名");
      const meta = document.createElement("div");
      meta.className = "slot-meta";
      meta.textContent = metaText(slot.snap);
      const ops = document.createElement("div");
      ops.className = "slot-ops";
      ops.innerHTML =
        '<button type="button" class="text-link slot-load" data-id="' + slot.id + '">读取</button>' +
        '<button type="button" class="text-link danger slot-del" data-id="' + slot.id + '">删除</button>';
      row.appendChild(nameEl);
      row.appendChild(meta);
      row.appendChild(ops);
      list.appendChild(row);
    }
  }

  global.GobanSlots = { load, add, get, remove, rename, render };
})(typeof window !== "undefined" ? window : globalThis);
