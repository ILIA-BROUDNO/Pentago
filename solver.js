// solver.js
// Perfect-play values for a position's children.
// - <=17 stones: the public perfect-pentago.net DB API.
// - 18+ stones:  the official mid.wasm solver, run in a worker.
//
// Both back-ends return values two half-moves deep (each placement AND its
// rotations), so results are cached by board. That means a full move (place
// decision + rotation decision) needs at most one solver call, and repeated
// positions (hints, undo/redo) are free. Values are exact, so we never evict.

import { solveMid } from './wasm-solve.js';

const API_BASE = 'https://us-central1-naml-148801.cloudfunctions.net/pentago/';

// ---- perfect-value cache: board name OR raw string -> -1 | 0 | 1 ----
const valueCache = new Map();

function remember(map) {
  for (const key in map) valueCache.set(key, map[key]);
}

function lookup(board) {
  if (valueCache.has(board.name)) return valueCache.get(board.name);
  const raw = String(board.raw);
  return valueCache.has(raw) ? valueCache.get(raw) : undefined;
}

// Values for every child of `board` (keyed by both name and raw), or null if
// any child is not yet cached.
function cachedChildValues(board) {
  const out = {};
  for (const child of board.moves()) {
    const v = lookup(child);
    if (v === undefined) return null;
    out[child.name] = v;
    out[String(child.raw)] = v;
  }
  return out;
}

// ---- solver worker (keeps the UI responsive during slow WASM solves) ----
let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./mid-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return (worker = null);
  }
  worker.addEventListener('message', ({ data: { id, result, error } }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  });
  worker.addEventListener('error', () => {
    for (const p of pending.values()) p.reject(new Error('Solver worker crashed'));
    pending.clear();
    worker = null;
  });
  return worker;
}

async function midsolve(raw) {
  const w = getWorker();
  if (w) {
    try {
      const id = nextId++;
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, raw: String(raw) });
      });
    } catch {
      // Worker failed mid-flight; fall back to inline computation.
    }
  }
  return solveMid(raw);
}

async function queryApi(boardName) {
  // Abort a stalled request so a hung network call can't freeze the UI.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(API_BASE + boardName, { signal: controller.signal });
    if (!res.ok) {
      throw new Error('Perfect API request failed: ' + res.status + ' ' + res.statusText);
    }
    return await res.json(); // { [boardName]: value, ... }
  } finally {
    clearTimeout(timer);
  }
}

// Perfect values for the current board's children, keyed by both name and raw.
export async function getPerfectValues(board) {
  const cached = cachedChildValues(board);
  if (cached) return cached;

  const map = board.count <= 17 ? await queryApi(board.name) : await midsolve(board.raw);
  remember(map);
  return cachedChildValues(board) ?? map;
}
