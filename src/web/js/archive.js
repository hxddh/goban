/**
 * 对局库(v1.63):每一局**下完**的棋自动留存,不用手动存档。
 *
 * 此前一局结束只剩计数:stats.js 记 {result, moves, durationMs},手顺不存。
 * 练习题只从「当前对局 + 手动存档槽」派生(app.js Practice.init),于是不点
 * 「另存」的对局,终局之后就再也回不去、出不了题、做不了次日复测。
 * 「每下一局学会一个判断」这条主线,第一步就断在这里。
 *
 * 存档槽(slots.js)仍然是「命名收藏」;这里是自动的、按时间滚动的对局库。
 * 两者都是 localStorage 上的一份 JSON,备份(backup.js)一并带走。
 *
 * 记录字段:
 *   id          稳定 id(时间戳 36 进制 + 随机)
 *   history     手顺 [{r,c}]
 *   ruleSet     'free' | 'renju' —— 复盘、出题都按这局**当时**的规则算
 *   mode / difficulty / humanColor
 *   result      'b' | 'w' | 'draw'
 *   startedAt / endedAt / durationMs
 *   lines       [{ply, moves:[{r,c}]}] 复盘里重下关键一手留下的分支(v1.63)
 *
 * 纯模块:只依赖 GobanHost 的三个存储函数,DOM 渲染由 app.js 负责。
 * @module archive
 */
(function (global) {
  const Host = global.GobanHost;
  const KEY = "goban.v12.games";
  /** 滚动上限。一局约 60 手 × 12 字节 ≈ 1KB,100 局远在配额之下。 */
  const MAX = 100;

  function load() {
    try {
      const raw = Host.storageGet(KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(valid) : [];
    } catch (_) {
      return [];
    }
  }

  function valid(e) {
    return !!(e && typeof e === "object" && typeof e.id === "string" &&
      Array.isArray(e.history) && e.history.length > 0);
  }

  function persist(arr) {
    return !!Host.storageSet(KEY, JSON.stringify(arr.slice(0, MAX)));
  }

  function genId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 留存一局(最新在前)。同一 endedAt 只记一次 —— 悔棋再赢回来的那一局由
   * app.js 先 remove 再 add,不在这里去重。
   * @returns {string|null} 新记录的 id;写入失败返回 null
   */
  function add(e) {
    const arr = load();
    const rec = {
      id: genId(),
      history: (e.history || []).map((p) => ({ r: p.r, c: p.c })),
      ruleSet: e.ruleSet === "renju" ? "renju" : "free",
      mode: e.mode === "pvp" ? "pvp" : "ai",
      difficulty: e.difficulty || null,
      humanColor: e.humanColor || null,
      result: e.result,
      startedAt: e.startedAt || Date.now(),
      endedAt: e.endedAt || Date.now(),
      durationMs: e.durationMs || 0,
      lines: [],
    };
    arr.unshift(rec);
    return persist(arr) ? rec.id : null;
  }

  function get(id) {
    return load().find((g) => g.id === id) || null;
  }

  /** 按 endedAt 删除 —— 悔棋撤销终局时与 stats.unrecordByEndedAt 同一把钥匙。 */
  function removeByEndedAt(endedAt) {
    if (typeof endedAt !== "number") return false;
    const arr = load();
    const idx = arr.findIndex((g) => g.endedAt === endedAt);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return persist(arr);
  }

  function remove(id) {
    return persist(load().filter((g) => g.id !== id));
  }

  /**
   * 给某一局挂一条分支(重下关键一手的结果)。同一 ply 只留最新一条:
   * 用户反复重下同一手,看的是最后那次。
   */
  function addLine(id, ply, moves) {
    const arr = load();
    const g = arr.find((x) => x.id === id);
    if (!g) return false;
    g.lines = (g.lines || []).filter((l) => l.ply !== ply);
    g.lines.push({ ply: ply, moves: moves.map((p) => ({ r: p.r, c: p.c })), at: Date.now() });
    return persist(arr);
  }

  function clear() { Host.storageRemove(KEY); }

  global.GobanArchive = { KEY, MAX, load, add, get, remove, removeByEndedAt, addLine, clear };
})(typeof window !== "undefined" ? window : globalThis);
