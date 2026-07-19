/**
 * SGF build / parse (FF4-ish, 15×15 gomoku).
 * @module sgf
 */
(function (global) {
  const Core = global.GobanCore;
  const SIZE = Core.SIZE;

  /** FF4 point: first letter = column, second = row, both from top-left ("aa"). */
  function sgfCoord(r, c) {
    return String.fromCharCode(97 + c) + String.fromCharCode(97 + r);
  }

  function parseSgfCoord(s) {
    if (!s || s.length < 2) return null;
    const c = s.charCodeAt(0) - 97;
    const r = s.charCodeAt(1) - 97;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    return { r, c };
  }

  /**
   * @param {object} opts
   * @param {{r:number,c:number}[]} opts.history
   * @param {string} opts.result play|b|w|draw
   * @param {string} opts.mode
   * @param {string} opts.humanColor
   * @param {number} opts.originalStartedAt
   */
  function buildSgf(opts) {
    const history = opts.history || [];
    const result = opts.result || "play";
    const mode = opts.mode || "ai";
    const humanColor = opts.humanColor || "b";
    const dt = new Date(opts.originalStartedAt || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const dtStr =
      dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    const re =
      result === "b" ? "B+R" : result === "w" ? "W+R" : result === "draw" ? "0" : "Void";
    let s =
      "(;FF[4]GM[4]SZ[" +
      SIZE +
      "]AP[Goban:1.19.1]DT[" +
      dtStr +
      "]RE[" +
      re +
      "]";
    if (mode === "ai") {
      s += "PB[" + (humanColor === "b" ? "Human" : "Computer") + "]";
      s += "PW[" + (humanColor === "w" ? "Human" : "Computer") + "]";
    } else {
      s += "PB[Black]PW[White]";
    }
    for (let i = 0; i < history.length; i++) {
      const p = history[i];
      const tag = i % 2 === 0 ? "B" : "W";
      s += ";" + tag + "[" + sgfCoord(p.r, p.c) + "]";
    }
    s += ")";
    return s;
  }

  /**
   * Minimal SGF parser: collect B[]/W[] in order. Ignores branches (takes first path).
   * @returns {{ history: {r:number,c:number}[], error?: string }}
   */
  function parseSgf(text) {
    if (text == null) return { history: [], error: "没有棋谱内容" };
    if (typeof text !== "string") return { history: [], error: "棋谱格式无效" };
    let src = text.replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
    if (!src) return { history: [], error: "棋谱为空" };
    if (src.length > 200000) return { history: [], error: "棋谱过大（上限约 200KB）" };
    // Drop comment-style text properties first — their free text can contain
    // move lookalikes such as "B[ii]" (escaped \] respected).
    src = src.replace(/(^|[^A-Za-z])(?:GC|C)\[(?:\\[\s\S]|[^\]\\])*\]/g, "$1 ");
    if (!/[;\s]*[BW]\s*\[/i.test(src) && !/\(/.test(src)) {
      return { history: [], error: "不像 SGF 文件（未找到 B[]/W[] 落子）" };
    }
    const sz = src.match(/SZ\[(\d+)\]/i);
    if (sz && Number(sz[1]) !== SIZE) {
      return { history: [], error: "仅支持 " + SIZE + " 路（文件为 " + sz[1] + " 路）" };
    }
    const history = [];
    const occupied = Core.emptyBoard();
    // Boundary required before B/W so setup props (AB[]/AW[]) and idents
    // ending in B/W never read as moves.
    const re = /(?:^|[;()\s])([BW])\s*\[([a-z]{0,2})\]/gi;
    let m;
    let skipped = 0;
    while ((m = re.exec(src))) {
      const color = m[1].toUpperCase() === "B" ? "b" : "w";
      const coord = m[2];
      if (!coord) { skipped++; continue; }
      const p = parseSgfCoord(coord.toLowerCase());
      if (!p) {
        return { history: [], error: "无法识别坐标「" + coord + "」" };
      }
      if (occupied[p.r][p.c]) {
        return {
          history: [],
          error: "第 " + (history.length + 1) + " 手与已有落点重叠（" + coord + "）",
        };
      }
      const want = history.length % 2 === 0 ? "b" : "w";
      if (color !== want) {
        return {
          history: [],
          error: "第 " + (history.length + 1) + " 手颜色应为" + (want === "b" ? "黑" : "白"),
        };
      }
      occupied[p.r][p.c] = color;
      history.push({ r: p.r, c: p.c });
    }
    if (!history.length) {
      return {
        history: [],
        error: skipped ? "只有停着/空落子，没有有效手数" : "未找到有效落子",
      };
    }
    return { history: history, skippedPasses: skipped };
  }

  function fileNameFromDate(ts) {
    // local wall-clock, not UTC — late-night exports should carry today's date
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return (
      "goban-" +
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      ".sgf"
    );
  }

  global.GobanSgf = {
    sgfCoord,
    parseSgfCoord,
    buildSgf,
    parseSgf,
    fileNameFromDate,
  };
})(typeof window !== "undefined" ? window : globalThis);
