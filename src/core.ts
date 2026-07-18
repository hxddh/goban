// Goban — five-in-a-row (Gomoku) for macOS.
// Model / Msg / update: pure TypeScript app-core subset.
//
// Subset gotchas:
// - `readonly number[]` / `number[][]` are float-classed — never put board
//   indices or row/col deltas in bare number arrays.
// - Keep id flows integer end-to-end (no `/`, no Math.floor on them).
// - AI is deterministic heuristic (no Math.random).

export const SIZE = 15;
const WIN = 5;
const CENTER = 7;
const CENTER_INDEX = 112; // 7 * 15 + 7

export type Stone = "empty" | "black" | "white";
export type Player = "black" | "white";
export type Phase = "playing" | "black_wins" | "white_wins" | "draw";
export type Mode = "pvp" | "ai";

export interface Cell {
  readonly index: number;
  readonly row: number;
  readonly col: number;
  readonly stone: Stone;
  readonly isBlack: boolean;
  readonly isWhite: boolean;
  readonly isEmpty: boolean;
  readonly isLast: boolean;
  readonly inLine: boolean;
  /** Last move and/or winning line — drives button `selected`. */
  readonly highlight: boolean;
}

export interface Move {
  readonly index: number;
}

export interface Model {
  readonly cells: readonly Cell[];
  readonly turn: Player;
  readonly phase: Phase;
  readonly mode: Mode;
  readonly history: readonly Move[];
  readonly winLine: readonly Move[];
  readonly moveCount: number;
  readonly lastMove: number;
  readonly isBlackTurn: boolean;
  readonly isWhiteTurn: boolean;
  readonly isPlaying: boolean;
  readonly blackWins: boolean;
  readonly whiteWins: boolean;
  readonly isDraw: boolean;
  readonly cannotUndo: boolean;
  readonly vsAi: boolean;
  readonly vsHuman: boolean;
}

export type Msg =
  | { readonly kind: "place"; readonly index: number }
  | { readonly kind: "undo" }
  | { readonly kind: "reset" }
  | { readonly kind: "set_mode_pvp" }
  | { readonly kind: "set_mode_ai" };

function idx(row: number, col: number): number {
  return row * SIZE + col;
}

function onBoard(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}

function lineContains(line: readonly Move[], index: number): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i].index === index) return true;
  }
  return false;
}

function makeCell(
  index: number,
  row: number,
  col: number,
  stone: Stone,
  lastMove: number,
  winLine: readonly Move[],
): Cell {
  const isLast = index === lastMove && stone !== "empty";
  const inLine = lineContains(winLine, index);
  return {
    index,
    row,
    col,
    stone,
    isBlack: stone === "black",
    isWhite: stone === "white",
    isEmpty: stone === "empty",
    isLast,
    inLine,
    highlight: isLast || inLine,
  };
}

function emptyBoard(): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      cells.push(makeCell(idx(row, col), row, col, "empty", -1, []));
    }
  }
  return cells;
}

function opponent(p: Player): Player {
  if (p === "black") return "white";
  return "black";
}

function stoneAt(cells: readonly Cell[], row: number, col: number): Stone {
  return cells[idx(row, col)].stone;
}

function countDir(
  cells: readonly Cell[],
  row: number,
  col: number,
  dr: number,
  dc: number,
  color: Stone,
): number {
  let n = 0;
  let r = row + dr;
  let c = col + dc;
  while (onBoard(r, c)) {
    if (stoneAt(cells, r, c) !== color) break;
    n++;
    r += dr;
    c += dc;
  }
  return n;
}

function collectDir(
  cells: readonly Cell[],
  row: number,
  col: number,
  dr: number,
  dc: number,
  color: Stone,
): Move[] {
  const out: Move[] = [];
  let r = row + dr;
  let c = col + dc;
  while (onBoard(r, c)) {
    if (stoneAt(cells, r, c) !== color) break;
    out.push({ index: idx(r, c) });
    r += dr;
    c += dc;
  }
  return out;
}

function winLineForDir(
  cells: readonly Cell[],
  row: number,
  col: number,
  dr: number,
  dc: number,
  color: Stone,
): Move[] {
  const total =
    1 + countDir(cells, row, col, dr, dc, color) + countDir(cells, row, col, -dr, -dc, color);
  if (total < WIN) return [];
  const a = collectDir(cells, row, col, dr, dc, color);
  const b = collectDir(cells, row, col, -dr, -dc, color);
  return [{ index: idx(row, col) }, ...a, ...b];
}

function findWinLine(
  cells: readonly Cell[],
  row: number,
  col: number,
  color: Stone,
): Move[] {
  // Unrolled directions — avoid number[] deltas (float-classed).
  let line = winLineForDir(cells, row, col, 0, 1, color);
  if (line.length >= WIN) return line;
  line = winLineForDir(cells, row, col, 1, 0, color);
  if (line.length >= WIN) return line;
  line = winLineForDir(cells, row, col, 1, 1, color);
  if (line.length >= WIN) return line;
  line = winLineForDir(cells, row, col, 1, -1, color);
  if (line.length >= WIN) return line;
  return [];
}

function isWin(cells: readonly Cell[], row: number, col: number, color: Stone): boolean {
  return findWinLine(cells, row, col, color).length >= WIN;
}

function boardFull(cells: readonly Cell[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].isEmpty) return false;
  }
  return true;
}

function rebuildCells(
  source: readonly Cell[],
  lastMove: number,
  winLine: readonly Move[],
): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    cells.push(makeCell(c.index, c.row, c.col, c.stone, lastMove, winLine));
  }
  return cells;
}

function withView(
  cells: readonly Cell[],
  turn: Player,
  phase: Phase,
  mode: Mode,
  history: readonly Move[],
  winLine: readonly Move[],
  lastMove: number,
): Model {
  return {
    cells,
    turn,
    phase,
    mode,
    history,
    winLine,
    moveCount: history.length,
    lastMove,
    isBlackTurn: phase === "playing" && turn === "black",
    isWhiteTurn: phase === "playing" && turn === "white",
    isPlaying: phase === "playing",
    blackWins: phase === "black_wins",
    whiteWins: phase === "white_wins",
    isDraw: phase === "draw",
    cannotUndo: history.length === 0,
    vsAi: mode === "ai",
    vsHuman: mode === "pvp",
  };
}

function absInt(n: number): number {
  if (n < 0) return 0 - n;
  return n;
}

function wouldWinAt(cells: readonly Cell[], index: number, color: Stone): boolean {
  const probe: Cell[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.index === index) {
      probe.push(makeCell(c.index, c.row, c.col, color, index, []));
    } else {
      probe.push(c);
    }
  }
  const cell = cells[index];
  return isWin(probe, cell.row, cell.col, color);
}

interface Ray {
  readonly count: number;
  readonly open: boolean;
}

function ray(
  cells: readonly Cell[],
  row: number,
  col: number,
  dr: number,
  dc: number,
  color: Stone,
): Ray {
  let count = 0;
  let r = row + dr;
  let c = col + dc;
  while (onBoard(r, c) && stoneAt(cells, r, c) === color) {
    count++;
    r += dr;
    c += dc;
  }
  const open = onBoard(r, c) && stoneAt(cells, r, c) === "empty";
  const result: Ray = { count, open };
  return result;
}

function patternScore(count: number, openEnds: number): number {
  // C1 weights: value live threes/fours more so the AI blocks them earlier.
  if (count >= 5) return 100000;
  if (count === 4 && openEnds === 2) return 50000; // open four
  if (count === 4 && openEnds === 1) return 20000; // half-open four
  if (count === 3 && openEnds === 2) return 5000; // open three
  if (count === 3 && openEnds === 1) return 400;
  if (count === 2 && openEnds === 2) return 200;
  if (count === 2 && openEnds === 1) return 30;
  if (count === 1 && openEnds === 2) return 12;
  return openEnds;
}

function lineScore(
  cells: readonly Cell[],
  row: number,
  col: number,
  dr: number,
  dc: number,
  color: Stone,
): number {
  const a = ray(cells, row, col, dr, dc, color);
  const b = ray(cells, row, col, -dr, -dc, color);
  const count = 1 + a.count + b.count;
  let openEnds = 0;
  if (a.open) openEnds++;
  if (b.open) openEnds++;
  return patternScore(count, openEnds);
}

function scoreAllDirs(cells: readonly Cell[], row: number, col: number, color: Stone): number {
  return (
    lineScore(cells, row, col, 0, 1, color) +
    lineScore(cells, row, col, 1, 0, color) +
    lineScore(cells, row, col, 1, 1, color) +
    lineScore(cells, row, col, 1, -1, color)
  );
}

/** How many empty cells would immediately win for `color`? */
function countWinningCells(cells: readonly Cell[], color: Stone): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].isEmpty) continue;
    if (!isNearStone(cells, i)) continue;
    if (wouldWinAt(cells, i, color)) n++;
  }
  return n;
}

function withStone(cells: readonly Cell[], index: number, color: Stone): Cell[] {
  const placed: Cell[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.index === index) {
      placed.push(makeCell(c.index, c.row, c.col, color, index, []));
    } else {
      placed.push(c);
    }
  }
  return placed;
}

function evaluateEmpty(cells: readonly Cell[], index: number, me: Player): number {
  const cell = cells[index];
  if (!cell.isEmpty) return -1;

  const mine: Stone = me;
  const theirs: Stone = opponent(me);

  // Tactical absolute priorities.
  if (wouldWinAt(cells, index, mine)) return 200000;
  if (wouldWinAt(cells, index, theirs)) return 150000;

  const attack = scoreAllDirs(cells, cell.row, cell.col, mine);
  const defense = scoreAllDirs(cells, cell.row, cell.col, theirs);
  const dist = absInt(cell.row - CENTER) + absInt(cell.col - CENTER);
  const centerBias = (14 - dist) * 3;

  // One-ply look: after we place, count forced wins next turn.
  const after = withStone(cells, index, mine);
  const myThreats = countWinningCells(after, mine);
  const theirThreats = countWinningCells(after, theirs);

  let threatBonus = 0;
  if (myThreats >= 2) threatBonus += 80000; // double threat / fork
  else if (myThreats === 1) threatBonus += 12000;
  // Leaving the opponent a win is almost always wrong (unless we already won).
  if (theirThreats >= 1) threatBonus -= 60000;

  // Prefer defense a bit more than pure attack when pattern scores are close.
  return attack + defense * 2 + centerBias + threatBonus;
}

function hasAnyStone(cells: readonly Cell[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].isEmpty) return true;
  }
  return false;
}

function isNearStone(cells: readonly Cell[], index: number): boolean {
  const cell = cells[index];
  for (let dr = -3; dr <= 3; dr++) {
    for (let dc = -3; dc <= 3; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = cell.row + dr;
      const c = cell.col + dc;
      if (!onBoard(r, c)) continue;
      if (stoneAt(cells, r, c) !== "empty") return true;
    }
  }
  return false;
}

/** Deterministic AI: highest heuristic; ties keep the smaller index. */
function chooseAiMove(cells: readonly Cell[], me: Player): number {
  if (!hasAnyStone(cells)) return CENTER_INDEX;

  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].isEmpty) continue;
    if (!isNearStone(cells, i)) continue;
    const score = evaluateEmpty(cells, i, me);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) {
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].isEmpty) return i;
    }
    return -1;
  }
  return bestIndex;
}

function applyPlace(model: Model, placedIndex: number): Model {
  if (model.phase !== "playing") return model;
  if (placedIndex < 0 || placedIndex >= model.cells.length) return model;

  const cell = model.cells[placedIndex];
  if (!cell.isEmpty) return model;

  const color: Stone = model.turn;
  const placed: Cell[] = [];
  for (let i = 0; i < model.cells.length; i++) {
    const c = model.cells[i];
    if (c.index === placedIndex) {
      placed.push(makeCell(c.index, c.row, c.col, color, placedIndex, []));
    } else {
      placed.push(makeCell(c.index, c.row, c.col, c.stone, placedIndex, []));
    }
  }

  const history: Move[] = [];
  for (let i = 0; i < model.history.length; i++) {
    history.push(model.history[i]);
  }
  history.push({ index: placedIndex });

  const winLine = findWinLine(placed, cell.row, cell.col, color);
  if (winLine.length >= WIN) {
    const phase: Phase = model.turn === "black" ? "black_wins" : "white_wins";
    const cells = rebuildCells(placed, placedIndex, winLine);
    return withView(cells, model.turn, phase, model.mode, history, winLine, placedIndex);
  }

  if (boardFull(placed)) {
    return withView(placed, model.turn, "draw", model.mode, history, [], placedIndex);
  }

  return withView(placed, opponent(model.turn), "playing", model.mode, history, [], placedIndex);
}

function undoOnce(model: Model): Model {
  if (model.history.length === 0) return model;

  const last = model.history[model.history.length - 1].index;
  const nextHistory: Move[] = [];
  for (let i = 0; i < model.history.length - 1; i++) {
    nextHistory.push(model.history[i]);
  }

  const nextLast = nextHistory.length === 0 ? -1 : nextHistory[nextHistory.length - 1].index;
  const cleared: Cell[] = [];
  for (let i = 0; i < model.cells.length; i++) {
    const c = model.cells[i];
    if (c.index === last) {
      cleared.push(makeCell(c.index, c.row, c.col, "empty", nextLast, []));
    } else {
      cleared.push(makeCell(c.index, c.row, c.col, c.stone, nextLast, []));
    }
  }

  const turn: Player = nextHistory.length % 2 === 0 ? "black" : "white";
  return withView(cleared, turn, "playing", model.mode, nextHistory, [], nextLast);
}

function fresh(mode: Mode): Model {
  return withView(emptyBoard(), "black", "playing", mode, [], [], -1);
}

export function initialModel(): Model {
  return fresh("ai");
}

/** Menus + shortcuts from app.zon → Msg. Unknown ids are ignored. */
export function commandMsg(name: string): Msg | null {
  if (name === "goban.new-game") return { kind: "reset" };
  if (name === "goban.undo") return { kind: "undo" };
  if (name === "goban.mode-pvp") return { kind: "set_mode_pvp" };
  if (name === "goban.mode-ai") return { kind: "set_mode_ai" };
  return null;
}

export function update(model: Model, msg: Msg): Model {
  switch (msg.kind) {
    case "reset":
      return fresh(model.mode);

    case "set_mode_pvp":
      return fresh("pvp");

    case "set_mode_ai":
      return fresh("ai");

    case "undo": {
      if (model.history.length === 0) return model;

      // AI mode: if last stone is White (computer), take back that reply
      // and the human move so Undo feels like "take back my move".
      const lastIndex = model.history[model.history.length - 1].index;
      const lastStone = model.cells[lastIndex].stone;
      let next = undoOnce(model);
      if (model.mode === "ai" && lastStone === "white" && next.history.length > 0) {
        next = undoOnce(next);
      }
      return next;
    }

    case "place": {
      let next = applyPlace(model, msg.index);
      if (next === model) return model;

      // Human is Black; AI replies as White in the same dispatch.
      if (next.mode === "ai" && next.phase === "playing" && next.turn === "white") {
        const aiIndex = chooseAiMove(next.cells, "white");
        if (aiIndex >= 0) {
          next = applyPlace(next, aiIndex);
        }
      }
      return next;
    }
  }
}
