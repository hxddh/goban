/**
 * Presentation helpers split out of app.js (v1.28): toasts, duration/time
 * formatting, modal focus handling, the move list and the swap2 prompt bar.
 *
 * Only pieces with a genuinely clean seam live here — each one either touches
 * nothing but the DOM, or reads game state through the plain arguments it is
 * given. The session-wide transitions (import, snapshot restore, the swap2
 * state machine) stay in app.js on purpose: they mutate a dozen module
 * variables at once, so moving them would relocate the coupling rather than
 * reduce it, and this refactor exists to make later changes safer, not to
 * make one file shorter.
 * @module ui
 */
(function (global) {
  const SIZE = (global.GobanCore && global.GobanCore.SIZE) || 15;

  let toastTimer = 0;
  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const ss = s % 60;
    const h = Math.floor(m / 60);
    if (h > 0) {
      return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    }
    return String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function modalFocusables(modal) {
    if (!modal) return [];
    return Array.from(
      modal.querySelectorAll(
        'button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => {
      if (el.closest("[hidden]")) return false;
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden";
    });
  }

  /** Keep Tab inside the topmost open dialog (confirm has its own 2-button cycle). */
  function trapModalTab(ev, modal) {
    if (ev.key !== "Tab" || !modal) return false;
    const list = modalFocusables(modal);
    if (!list.length) return false;
    ev.preventDefault();
    const i = list.indexOf(document.activeElement);
    let next;
    if (ev.shiftKey) next = i <= 0 ? list[list.length - 1] : list[i - 1];
    else next = i < 0 || i >= list.length - 1 ? list[0] : list[i + 1];
    next.focus();
    return true;
  }

  /** Rebuild only when the move sequence changed; `cur` highlight every call. */
  let mlSig = "";
  function renderMoveList(history, viewIndex, gameGen) {
    const el = document.getElementById("move-list");
    if (!el) return;
    const last = history.length ? history[history.length - 1] : null;
    const sig = history.length + ":" + (last ? last.r + "," + last.c : "") + ":" + gameGen;
    if (sig !== mlSig) {
      mlSig = sig;
      let html = "";
      for (let i = 0; i < history.length; i++) {
        const p = history[i];
        const lab = String.fromCharCode(65 + p.c) + (SIZE - p.r);
        // tabindex=-1: list is navigated by click / replay keys, not Tab-steal from board
        html +=
          '<button type="button" tabindex="-1" data-i="' + (i + 1) + '">' +
          (i + 1) + ". " + lab + "</button>";
      }
      el.innerHTML = html;
    }
    const btns = el.children;
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("cur", i + 1 === viewIndex);
    }
  }

  /** Scroll #move-list only — never element.scrollIntoView (pulls a closed panel into view in WKWebView). */
  function scrollMoveListToCurrent() {
    const el = document.getElementById("move-list");
    if (!el) return;
    const cur = el.querySelector("button.cur");
    if (!cur) return;
    const listH = el.clientHeight;
    if (listH <= 0) return;
    const top = cur.offsetTop - listH / 2 + cur.offsetHeight / 2;
    el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - listH));
  }

  function hideSwap2Bar(appEl) {
    const bar = document.getElementById("swap2-bar");
    if (bar) bar.hidden = true;
    if (appEl) appEl.classList.remove("swap2-on");
  }

  /** `swap2` is the live phase object (or null); `placed` = stones laid so far. */
  function renderSwap2Bar(appEl, swap2, placed) {
    const bar = document.getElementById("swap2-bar");
    const msg = document.getElementById("swap2-msg");
    const btns = document.getElementById("swap2-btns");
    if (!bar || !msg || !btns) return;
    if (!swap2) {
      bar.hidden = true;
      if (appEl) appEl.classList.remove("swap2-on");
      return;
    }
    if (appEl) appEl.classList.add("swap2-on");
    if (swap2.phase === "place" || swap2.phase === "place2") {
      const target = swap2.phase === "place" ? 3 : 5;
      btns.innerHTML = "";
      msg.textContent = "平衡开局 · 请落第 " + (placed + 1) + " 子（共 " + target + "）";
      bar.hidden = false;
      return;
    }
    let items;
    if (swap2.phase === "p2choose") {
      msg.textContent = "开局已布 3 子 · 由你选择：";
      items = [["black", "执黑"], ["white", "执白"], ["add2", "加两手"]];
    } else { // p1choose
      msg.textContent = "对手已加两手 · 请选择执子：";
      items = [["black", "执黑"], ["white", "执白"]];
    }
    btns.innerHTML = "";
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swap2-btn";
      b.dataset.kind = it[0];
      b.textContent = it[1];
      btns.appendChild(b);
    }
    bar.hidden = false;
  }

  global.GobanUi = {
    toast,
    formatDuration,
    formatTime,
    modalFocusables,
    trapModalTab,
    renderMoveList,
    scrollMoveListToCurrent,
    hideSwap2Bar,
    renderSwap2Bar,
  };
})(typeof window !== "undefined" ? window : globalThis);
