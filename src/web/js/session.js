/**
 * 偏好与这一局(v1.64)。
 *
 * v1.63 的 9 个问题里有 6 个出在模式的接缝上,根是同一件事:「玩家在侧栏选的」和
 * 「这一局正在用的」共用一组变量。导入的连珠棋谱、库里打开的双人旧局、重下时强制的
 * 人机与执子,都会写进那组变量,再被下一次 saveSettings() 当成偏好存走,下一次「新局」
 * 就按它开。v1.63.1 先把规则拆开了;这里把四项一起拆:
 *
 *   偏好(Prefs) —— 侧栏那四格:模式 / 难度 / 执子 / 规则。只有玩家点选会改它,
 *                   只有它进设置存储,新局只从它开。
 *   这一局        —— app.js 里的 mode / difficulty / humanColor / ruleSet / openingRule。
 *                   新局从偏好抄一份;导入、旧局、重下、swap2 只改这一份。
 *
 * 另一半是「这一局是哪一种」。kind 不存,每次从状态推出来 —— 存两份就会有不一致的
 * 那一刻。每种 kind 的行为写成一张表(POLICY),app.js 只查表,不再各处特判。
 *
 * 纯函数、无 DOM:scripts/test-game.mjs 直接加载,对 kind × 操作逐格断言。
 * @module session
 */
(function (global) {
  const DEFAULT_PREFS = Object.freeze({ mode: "ai", difficulty: "normal", humanColor: "b", rule: "free" });
  const DIFFS = ["easy", "normal", "hard", "extreme"];
  const RULES = ["free", "swap2", "renju"];

  /**
   * 从设置存储读出偏好,坏值一律回到默认。旧存储里规则是两个字段
   * (ruleSet + openingRule),在这里合成侧栏那一格;禁手不叠 swap2。
   */
  function readPrefs(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const p = Object.assign({}, DEFAULT_PREFS);
    if (s.mode === "ai" || s.mode === "pvp") p.mode = s.mode;
    if (DIFFS.includes(s.difficulty)) p.difficulty = s.difficulty;
    if (s.humanColor === "b" || s.humanColor === "w") p.humanColor = s.humanColor;
    if (RULES.includes(s.rule)) p.rule = s.rule;
    else p.rule = ruleOf(s.ruleSet, s.openingRule);
    return p;
  }

  /** 偏好写回存储的形状。两个旧字段照写,降级到 v1.63 的人读得回来。 */
  function prefsToStore(p) {
    const f = ruleFields(p.rule);
    return { mode: p.mode, difficulty: p.difficulty, humanColor: p.humanColor, rule: p.rule, ruleSet: f.ruleSet, openingRule: f.openingRule };
  }

  /** 侧栏那一格 → 两个内部字段(swap2 的协议与禁手的判定是两套代码)。 */
  function ruleFields(rule) {
    return { ruleSet: rule === "renju" ? "renju" : "free", openingRule: rule === "swap2" ? "swap2" : "standard" };
  }

  /** 两个内部字段 → 侧栏那一格。 */
  function ruleOf(ruleSet, openingRule) {
    if (ruleSet === "renju") return "renju";
    return openingRule === "swap2" ? "swap2" : "free";
  }

  /**
   * 新局从偏好开:这一局的五个字段整份来自偏好,不从上一局继承任何东西。
   * @returns {{mode,difficulty,humanColor,ruleSet,openingRule}}
   */
  function gameFromPrefs(p) {
    const f = ruleFields(p.rule);
    return { mode: p.mode, difficulty: p.difficulty, humanColor: p.humanColor, ruleSet: f.ruleSet, openingRule: f.openingRule };
  }

  /**
   * 这一局是哪一种。
   *   retry  —— 重下关键一手:原局存在 retry.source 里,失着之前那段不属于这盘
   *   import —— 导入后的纯复盘,落第一子或「续下」之前电脑不动
   *   play   —— 其余一切(新局、存档读回、库里打开的旧局)
   * @param {{retry?:object|null, importPaused?:boolean}} st
   */
  function kindOf(st) {
    if (st && st.retry) return "retry";
    if (st && st.importPaused) return "import";
    return "play";
  }

  /**
   * 每种 kind 的行为。
   *   onFinish      终局时:'record' 进统计与对局库;'branch' 作为分支挂回原局
   *   undoFloor     悔棋最多退到第几手之后(函数:要看重下从哪一手起)
   *   autoAi        轮到电脑时电脑是否自己走
   */
  const POLICY = Object.freeze({
    play:   Object.freeze({ onFinish: "record", undoFloor: () => 0, autoAi: true }),
    import: Object.freeze({ onFinish: "record", undoFloor: () => 0, autoAi: false }),
    retry:  Object.freeze({ onFinish: "branch", undoFloor: (st) => Math.max(0, st.retry.ply - 1), autoAi: true }),
  });

  function policy(st) { return POLICY[kindOf(st)]; }

  /** 悔棋最多退到这一手之后。 */
  function undoFloor(st) { return policy(st).undoFloor(st); }

  global.GobanSession = {
    DEFAULT_PREFS, readPrefs, prefsToStore, ruleFields, ruleOf, gameFromPrefs,
    kindOf, policy, undoFloor, POLICY,
  };
})(typeof window !== "undefined" ? window : globalThis);
