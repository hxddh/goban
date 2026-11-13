/**
 * SGF build / parse (FF4-ish, 15×15 gomoku).
 * @module sgf
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
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

  /** Escape SGF text so ] and \ inside C[] don't terminate the property. */
  function sgfText(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  }

  /**
   * @param {object} opts
   * @param {{r:number,c:number}[]} opts.history
   * @param {string} opts.result play|b|w|draw
   * @param {string} opts.mode
   * @param {string} opts.humanColor
   * @param {string} [opts.ruleSet] free|renju — written as RU[Gomoku]/RU[Renju]
   * @param {number} opts.originalStartedAt
   * @param {Object<number,string>} [opts.comments] 0-based move index → C[] note
   * @param {string} [opts.rootComment] C[] note on the game-info (root) node
   * @param {Object<number,{r:number,c:number}[][]>} [opts.variations]
   *        0-based move index → 替代着序列列表。写成该手的**兄弟变着**
   *        `(;B[..]C[..])`,标准 SGF 阅读器都能切换查看;本应用导入时只读主线。
   */
  function buildSgf(opts) {
    const history = opts.history || [];
    const result = opts.result || "play";
    const mode = opts.mode || "ai";
    const humanColor = opts.humanColor || "b";
    // RU 是 SGF 的标准规则字段。以前不写,于是导出的每一份棋谱都默认按自由式
    // 读 —— 一局连珠里黑的六连在别的软件里会显示成黑胜,而这局棋里它是禁手。
    const ruleSet = opts.ruleSet === "renju" ? "Renju" : "Gomoku";
    const comments = opts.comments || null;
    const rootComment = opts.rootComment || "";
    const dt = new Date(opts.originalStartedAt || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const dtStr =
      dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    // RE 的第二段是**赢法**,不是装饰:SGF 里 `+R` = Resign(对手认输)、`+T` = 超时、
    // `+F` = 判负,而 `B+` 就是「黑胜,方式未指定」。这里一直写死 `B+R` / `W+R` ——
    // 而这个应用**没有认输功能**(全 src/ 搜 resign / 认输,0 处命中),赢棋只有连五
    // 一种方式。也就是说导出的每一份棋谱都在对别的软件说假话:一局连五赢下来的棋,
    // 在任何 SGF 阅读器里都显示成「对手认输」。
    //
    // 自己导入自己看不出来 —— 解析器根本不读 RE,结果是从盘面重算的。这个字段唯一的
    // 读者在应用之外,所以也从来没有测试碰过它。
    const re =
      result === "b" ? "B+" : result === "w" ? "W+" : result === "draw" ? "0" : "Void";
    let s =
      "(;FF[4]GM[4]SZ[" +
      SIZE +
      "]AP[Goban:" + (global.GOBAN_VERSION || "0.0.0") + "]DT[" +
      dtStr +
      "]RE[" +
      re +
      "]RU[" +
      ruleSet +
      "]";
    if (mode === "ai") {
      s += "PB[" + (humanColor === "b" ? "Human" : "Computer") + "]";
      s += "PW[" + (humanColor === "w" ? "Human" : "Computer") + "]";
    } else {
      s += "PB[Black]PW[White]";
    }
    if (rootComment) s += "C[" + sgfText(rootComment) + "]";
    const variations = opts.variations || null;
    const pendingAlts = [];
    // 变着要写成兄弟节点:`(;主线…)(;变着…)`。主线自己也得进一对括号,
    // 而括号从第一处有变着的手开始,一直包到终点 —— 所以先数需要关几层。
    let open = 0;
    for (let i = 0; i < history.length; i++) {
      const p = history[i];
      const tag = i % 2 === 0 ? "B" : "W";
      const alts = variations && variations[i] && variations[i].length ? variations[i] : null;
      if (alts) { s += "("; open++; }
      s += ";" + tag + "[" + sgfCoord(p.r, p.c) + "]";
      if (comments && comments[i] != null) s += "C[" + sgfText(comments[i]) + "]";
      if (alts) {
        // 主线的这一手之后的所有节点都属于这一支,所以变着放到最后统一写;
        // 这里只记下来。
        pendingAlts.push({ i: i, alts: alts, tag0: tag });
      }
    }
    // 由内向外关闭:最晚开的那一支先关,然后紧跟它的兄弟变着。
    while (pendingAlts.length) {
      const v = pendingAlts.pop();
      s += ")";
      for (const line of v.alts) {
        s += "(";
        for (let k = 0; k < line.length; k++) {
          const tag = (v.i + k) % 2 === 0 ? "B" : "W";
          s += ";" + tag + "[" + sgfCoord(line[k].r, line[k].c) + "]";
          if (k === 0 && line.comment) s += "C[" + sgfText(line.comment) + "]";
        }
        s += ")";
      }
    }
    s += ")";
    return s;
  }
  /**
   * RU[] → 本应用的规则档。SGF 里的规则名没有统一写法,按前缀宽松认:
   * Renju / RIF / 连珠 → 'renju';Gomoku / Free / Freestyle / 五子 → 'free';
   * 其他或缺省 → null(调用方保持当前规则)。
   */
  function ruleFromSgf(src) {
    for (const nd of mainlineNodes(String(src || ""))) {
      for (const p of nd) if (p.name === "RU") return ruleFromValue(p.values[0]);
    }
    return null;
  }

  function ruleFromValue(raw) {
    const v = String(raw || "").trim().toLowerCase();
    if (/^(renju|rif|连珠)/.test(v)) return "renju";
    if (/^(gomoku|free|standard|五子)/.test(v)) return "free";
    return null;
  }

  /**
   * Main line of the first game as a list of nodes, each a list of
   * {name, values}. v3.2.1 replaces the old regex scan, which
   *   - recursed once per "(" (≈60k nested parens blew the stack),
   *   - read B/W only after `;(` `)` or whitespace (`;N[x]B[ij]` lost its move),
   *   - read B[..] / RU[..] out of free text (`PB[Alice B[hh]` made up a move).
   * A real tokenizer, iterative: an SGF sequence's variations only ever come at
   * its end, so the main line is "every node from the first '(' until the first
   * ')'", entering each '(' on the way (the first variation) — no stack needed.
   */
  function mainlineNodes(src) {
    const nodes = [];
    let i = src.indexOf("(");
    if (i < 0) i = 0; // bare ";B[..];W[..]" without a tree: read it the same way
    else i++;
    let node = null;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === ")") break;
      if (c === "(") { i++; continue; }
      if (c === ";") { node = []; nodes.push(node); i++; continue; }
      if (/[A-Za-z]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z]/.test(src[j])) j++;
        // FF[1–3] spelled ids with lowercase letters (AddBlack = AB): only capitals count
        const name = src.slice(i, j).replace(/[a-z]/g, "");
        i = j;
        while (i < n && /\s/.test(src[i])) i++;
        const values = [];
        while (i < n && src[i] === "[") {
          i++;
          let v = "";
          while (i < n && src[i] !== "]") {
            if (src[i] === "\\" && i + 1 < n) { v += src[i + 1]; i += 2; continue; }
            v += src[i++];
          }
          i++; // past ']' (or past the end on an unterminated value)
          values.push(v);
          while (i < n && /\s/.test(src[i])) i++;
        }
        if (values.length && name) {
          if (!node) { node = []; nodes.push(node); }
          node.push({ name: name, values: values });
        }
        continue;
      }
      i++; // whitespace / stray characters between properties
    }
    return nodes;
  }

  /**
   * Minimal SGF parser: collect B[]/W[] along the main line only
   * (first variation at each fork; first game in a collection).
   * @returns {{ history: {r:number,c:number}[], error?: string }}
   */
  function parseSgf(text) {
    if (text == null) return { history: [], error: t("sgf.err.noContent") };
    if (typeof text !== "string") return { history: [], error: t("sgf.err.invalid") };
    const src = text.replace(/﻿/g, "").trim();
    if (!src) return { history: [], error: t("sgf.err.empty") };
    if (src.length > 200000) return { history: [], error: t("sgf.err.tooBig") };
    const nodes = mainlineNodes(src);
    if (!nodes.some((nd) => nd.some((p) => p.name === "B" || p.name === "W"))) {
      return { history: [], error: t(nodes.length ? "sgf.err.noMoves" : "sgf.err.notSgf") };
    }
    let ruleSet = null;
    let sizeChecked = false;
    const history = [];
    const occupied = Core.emptyBoard();
    let skipped = 0;
    for (const nd of nodes) {
      for (const p of nd) {
        if (p.name === "SZ" && !sizeChecked) {
          sizeChecked = true;
          // SZ[15] or the rectangular form SZ[15:15]
          const m = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(p.values[0]);
          const w = m ? Number(m[1]) : NaN, h = m && m[2] ? Number(m[2]) : w;
          if (w !== SIZE || h !== SIZE) {
            return { history: [], error: t("sgf.err.size", { want: SIZE, got: m ? (m[2] ? m[1] + ":" + m[2] : m[1]) : p.values[0] }) };
          }
          continue;
        }
        // 规则随棋谱走。此前导出写 RU[] 而导入不读,一份连珠棋谱在自由档下载入,
        // 黑的六连会被重算成黑胜 —— 往返不能保留规则。
        if (p.name === "RU") { if (ruleSet === null) ruleSet = ruleFromValue(p.values[0]); continue; }
        if (p.name !== "B" && p.name !== "W") continue;
        const color = p.name === "B" ? "b" : "w";
        const coord = String(p.values[0] || "").trim();
        if (!coord) { skipped++; continue; }
        const p2 = /^[a-z]{2}$/i.test(coord) ? parseSgfCoord(coord.toLowerCase()) : null;
        if (!p2) {
          return { history: [], error: t("sgf.err.coord", { raw: coord.slice(0, 12) }) };
        }
        if (occupied[p2.r][p2.c]) {
          return {
            history: [],
            error: t("sgf.err.overlap", { n: history.length + 1, coord: coord }),
          };
        }
        const want = history.length % 2 === 0 ? "b" : "w";
        if (color !== want) {
          return {
            history: [],
            error: t("sgf.err.color", { n: history.length + 1, color: t(want === "b" ? "side.black" : "side.white") }),
          };
        }
        occupied[p2.r][p2.c] = color;
        history.push({ r: p2.r, c: p2.c });
      }
    }
    if (!history.length) {
      return {
        history: [],
        error: t(skipped ? "sgf.err.onlyPass" : "sgf.err.noMoves"),
      };
    }
    return { history: history, skippedPasses: skipped, ruleSet: ruleSet };
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
    ruleFromSgf,
    fileNameFromDate,
  };
})(typeof window !== "undefined" ? window : globalThis);
