// mid-worker.js
// Runs the WASM midgame solver off the main thread so the UI stays responsive
// (the spinner keeps animating) during the multi-second solve.

import { solveMid } from './wasm-solve.js';

self.onmessage = async (e) => {
  const { id, raw } = e.data;
  try {
    self.postMessage({ id, result: await solveMid(raw) });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
