// Goban — five-in-a-row (Gomoku) for macOS.
// Model / Msg / update: pure TypeScript app-core subset.
//
// Important: `readonly number[]` is float-classed in the app-core. Board
// indices must stay integer-classed, so history stores `{ index }` records.

export const SIZE = 15;
const WIN = 5;

export type Stone = "empty" | "black" | "white";
export type Player = "black" | "white";
export type Phase = "playing" | "black_wins" | "white_wins" | "draw";

export interface Cell {
  readonly index: number;
  readonly row: number;
  readonly col: number;
  readonly stone: Stone;
  readonly isBlack: boolean;
  readonly isWhite: boolean;
  readonly isEmpty: boolean;
  readonly isLast: boolean;
}

export interface Move {
  readonly index: number;
}

export interface Model {
  readonly cells: readonly Cell[];
  readonly turn: Player;
  readonly phase: Phase;
  readonly history: readonly Move[];
  readonly moveCount: number;
  readonly lastMove: number;
  readonly isBlackTurn: boolean;
  readonly isWhiteTurn: boolean;
  readonly isPlaying: boolean;
  readonly blackWins: boolean;
  readonly whiteWins: boolean;
  readonly isDraw: boolean;
  readonly cannotUndo: boolean;
}

export type Msg =
  | { readonly kind: "place"; readonly index: number }
  | { readonly kind: "undo" }
  | { readonly kind: "reset" };

function idx(row: number, col: number): number {
  return row * SIZE + col;
}

function makeCell(
  index: number,
  row: number,
  col: number,
  stone: Stone,
  lastMove: number,
): Cell {
  return {
    index,
    row,
    col,
    stone,
    isBlack: stone === "black",
    isWhite: stone === "white",
    isEmpty: stone === "empty",
    isLast: index === lastMove && stone !== "empty",
  };
}

function emptyBoard(): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      cells.push(makeCell(idx(row, col), row, col, "empty", -1));
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
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
    if (stoneAt(cells, r, c) !== color) break;
    n++;
    r += dr;
    c += dc;
  }
  return n;
}

function isWin(cells: readonly Cell[], row: number, col: number, color: Stone): boolean {
  if (1 + countDir(cells, row, col, 0, 1, color) + countDir(cells, row, col, 0, -1, color) >= WIN) {
    return true;
  }
  if (1 + countDir(cells, row, col, 1, 0, color) + countDir(cells, row, col, -1, 0, color) >= WIN) {
    return true;
  }
  if (1 + countDir(cells, row, col, 1, 1, color) + countDir(cells, row, col, -1, -1, color) >= WIN) {
    return true;
  }
  if (1 + countDir(cells, row, col, 1, -1, color) + countDir(cells, row, col, -1, 1, color) >= WIN) {
    return true;
  }
  return false;
}

function boardFull(cells: readonly Cell[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].isEmpty) return false;
  }
  return true;
}

function withView(
  cells: readonly Cell[],
  turn: Player,
  phase: Phase,
  history: readonly Move[],
  lastMove: number,
): Model {
  return {
    cells,
    turn,
    phase,
    history,
    moveCount: history.length,
    lastMove,
    isBlackTurn: phase === "playing" && turn === "black",
    isWhiteTurn: phase === "playing" && turn === "white",
    isPlaying: phase === "playing",
    blackWins: phase === "black_wins",
    whiteWins: phase === "white_wins",
    isDraw: phase === "draw",
    cannotUndo: history.length === 0,
  };
}

export function initialModel(): Model {
  return withView(emptyBoard(), "black", "playing", [], -1);
}

export function update(model: Model, msg: Msg): Model {
  switch (msg.kind) {
    case "reset":
      return initialModel();

    case "undo": {
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
          cleared.push(makeCell(c.index, c.row, c.col, "empty", nextLast));
        } else {
          cleared.push(makeCell(c.index, c.row, c.col, c.stone, nextLast));
        }
      }

      const turn: Player = nextHistory.length % 2 === 0 ? "black" : "white";
      return withView(cleared, turn, "playing", nextHistory, nextLast);
    }

    case "place": {
      if (model.phase !== "playing") return model;
      if (msg.index < 0 || msg.index >= model.cells.length) return model;

      const cell = model.cells[msg.index];
      if (!cell.isEmpty) return model;

      const color: Stone = model.turn;
      const placedIndex = msg.index;
      const placed: Cell[] = [];
      for (let i = 0; i < model.cells.length; i++) {
        const c = model.cells[i];
        if (c.index === placedIndex) {
          placed.push(makeCell(c.index, c.row, c.col, color, placedIndex));
        } else {
          placed.push(makeCell(c.index, c.row, c.col, c.stone, placedIndex));
        }
      }

      const history: Move[] = [];
      for (let i = 0; i < model.history.length; i++) {
        history.push(model.history[i]);
      }
      history.push({ index: placedIndex });

      if (isWin(placed, cell.row, cell.col, color)) {
        const phase: Phase = model.turn === "black" ? "black_wins" : "white_wins";
        return withView(placed, model.turn, phase, history, placedIndex);
      }

      if (boardFull(placed)) {
        return withView(placed, model.turn, "draw", history, placedIndex);
      }

      return withView(placed, opponent(model.turn), "playing", history, placedIndex);
    }
  }
}
