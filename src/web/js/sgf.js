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
    const m = src.match(/RU\s*\[([^\]]*)\]/i);
    if (!m) return null;
    const v = m[1].trim().toLowerCase();
    if (/^(renju|rif|连珠)/.test(v)) return "renju";
    if (/^(gomoku|free|standard|五子)/.test(v)) return "free";
    return null;
  }

  /**
   * Keep only the first game's main line. Sibling variations and later games
   * in a collection are dropped so a flat B[]/W[] scan cannot stitch branches.
   */
  function extractMainline(src) {
    let i = 0;
    while (i < src.length && src[i] !== "(") i++;
    if (i >= src.length) return src;
    let out = "";
    function skipPropValue() {
      i++; // past '['
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "]") {
          i++;
          return;
        }
        i++;
      }
    }
    function walkTree(emit) {
      if (src[i] !== "(") return;
      if (emit) out += "(";
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === ";") {
          const start = i;
          i++;
          while (i < src.length && src[i] !== ";" && src[i] !== "(" && src[i] !== ")") {
            if (src[i] === "[") skipPropValue();
            else i++;
          }
          if (emit) out += src.slice(start, i);
        } else if (c === "(") {
          walkTree(emit);
          while (i < src.length && src[i] === "(") walkTree(false);
        } else if (c === ")") {
          if (emit) out += ")";
          i++;
          return;
        } else {
          if (emit) out += c;
          i++;
        }
      }
    }
    walkTree(true);
    return out || src;
  }

  /**
   * Minimal SGF parser: collect B[]/W[] along the main line only
   * (first variation at each fork; first game in a collection).
   * @returns {{ history: {r:number,c:number}[], error?: string }}
   */
  function parseSgf(text) {
    if (text == null) return { history: [], error: t("sgf.err.noContent") };
    if (typeof text !== "string") return { history: [], error: t("sgf.err.invalid") };
    let src = text.replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
    if (!src) return { history: [], error: t("sgf.err.empty") };
    if (src.length > 200000) return { history: [], error: t("sgf.err.tooBig") };
    // Drop comment-style text properties first — their free text can contain
    // move lookalikes such as "B[ii]" (escaped \] respected).
    src = src.replace(/(^|[^A-Za-z])(?:GC|C)\[(?:\\[\s\S]|[^\]\\])*\]/g, "$1 ");
    src = extractMainline(src);
    if (!/[;\s]*[BW]\s*\[/i.test(src) && !/\(/.test(src)) {
      return { history: [], error: t("sgf.err.notSgf") };
    }
    const sz = src.match(/SZ\[(\d+)\]/i);
    if (sz && Number(sz[1]) !== SIZE) {
      return { history: [], error: t("sgf.err.size", { want: SIZE, got: sz[1] }) };
    }
    // 规则随棋谱走。此前导出写 RU[] 而导入不读,一份连珠棋谱在自由档下载入,
    // 黑的六连会被重算成黑胜 —— 往返不能保留规则。
    const ruleSet = ruleFromSgf(src);
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
        return { history: [], error: t("sgf.err.coord", { raw: coord }) };
      }
      if (occupied[p.r][p.c]) {
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
      occupied[p.r][p.c] = color;
      history.push({ r: p.r, c: p.c });
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
