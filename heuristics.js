// heuristics.js
// Fast local move selection without any API/WASM calls.
// Returns dbAPI-like maps ({ [childBoardKey]: -1|0|1 }) but only for one best child.

import { getStone } from './board.js';

const RAYS = (() => {
  const rays = [];

  // horizontal windows of 5
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c <= 1; c++) {
      rays.push([[r, c], [r, c + 1], [r, c + 2], [r, c + 3], [r, c + 4]]);
    }
  }

  // vertical windows of 5
  for (let c = 0; c < 6; c++) {
    for (let r = 0; r <= 1; r++) {
      rays.push([[r, c], [r + 1, c], [r + 2, c], [r + 3, c], [r + 4, c]]);
    }
  }

  // diagonal down-right windows of 5
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c <= 1; c++) {
      rays.push([[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3], [r + 4, c + 4]]);
    }
  }

  // diagonal down-left windows of 5
  for (let r = 0; r <= 1; r++) {
    for (let c = 4; c < 6; c++) {
      rays.push([[r, c], [r + 1, c - 1], [r + 2, c - 2], [r + 3, c - 3], [r + 4, c - 4]]);
    }
  }

  return rays;
})();

const LINE_WEIGHT = [0, 1, 4, 14, 50, 500];

function winner(board) {
  const bw = board.fives.some(f => board.grid[6 * f[0][0] + f[0][1]] === 1);
  const ww = board.fives.some(f => board.grid[6 * f[0][0] + f[0][1]] === 2);
  if (bw && ww) return 0;
  if (bw) return 1;
  if (ww) return 2;
  return 0;
}

function evaluateBoard(board, me) {
  const opp = me === 1 ? 2 : 1;

  if (board.done) {
    const w = winner(board);
    if (w === me) return 1_000_000;
    if (w === opp) return -1_000_000;
    return 0;
  }

  let score = 0;

  for (const ray of RAYS) {
    let meCount = 0;
    let oppCount = 0;

    for (const [r, c] of ray) {
      const s = getStone(board, r, c);
      if (s === me) meCount++;
      else if (s === opp) oppCount++;
    }

    if (meCount && oppCount) continue;
    if (meCount) score += LINE_WEIGHT[meCount];
    else if (oppCount) score -= LINE_WEIGHT[oppCount];
  }

  // Mild center preference.
  for (let r = 1; r <= 4; r++) {
    for (let c = 1; c <= 4; c++) {
      const s = getStone(board, r, c);
      if (s === me) score += 1;
      else if (s === opp) score -= 1;
    }
  }

  return score;
}

function toTernaryValue(score) {
  if (score > 2) return 1;
  if (score < -2) return -1;
  return 0;
}

function candidateChildren(board, moves = null) {
  const children = board.moves();
  if (!moves || !moves.length) return children;

  const byName = new Map();
  const byRaw = new Map();
  for (const ch of children) {
    byName.set(ch.name, ch);
    byRaw.set(String(ch.raw), ch);
  }

  const picked = [];
  const seen = new Set();
  for (const k of moves) {
    const key = String(k);
    const ch = byName.get(key) || byRaw.get(key);
    if (!ch) continue;
    if (seen.has(ch.name)) continue;
    seen.add(ch.name);
    picked.push(ch);
  }
  return picked;
}

function bestChildMap(board, moves = null) {
  const children = candidateChildren(board, moves);
  if (!children.length) return {};

  const me = board.currentPlayer;
  let best = children[0];
  let bestScore = evaluateBoard(best, me);

  for (let i = 1; i < children.length; i++) {
    const ch = children[i];
    const score = evaluateBoard(ch, me);
    if (score > bestScore) {
      best = ch;
      bestScore = score;
    }
  }

  return { [best.name]: toTernaryValue(bestScore) };
}

// Perfect-value-like contract: given a board (and optionally a subset of child
// keys), return a { [bestChildName]: -1|0|1 } map for the single best child.
export async function getHeuristicValues(board, moves = null) {
  return bestChildMap(board, moves);
}
