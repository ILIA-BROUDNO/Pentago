// wasm-solve.js
// Shared WebAssembly midgame solver, used by both the worker (mid-worker.js)
// and the inline fallback in solver.js. The module is compiled once; a fresh
// instance is created per solve (mirrors the original girving client).

let modulePromise = null;

function loadModule() {
  if (!modulePromise) {
    modulePromise = fetch(new URL('./mid.wasm', import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load mid.wasm: HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes));
  }
  return modulePromise;
}

// Solve an 18+ stone position. Returns { [rawBoardString]: -1|0|1 } covering
// the board, its placements, and every placement's rotations.
export async function solveMid(raw) {
  const mod = await loadModule();
  const inst = await WebAssembly.instantiate(mod, {
    env: { die: (ptr) => { throw new Error('WASM fatal error at ' + ptr); } },
  });
  const M = inst.exports;
  const mem = M.memory;

  const LIMIT = 1 + 18 + 8 * 18; // self + placements + rotations
  const resultsPtr = M.malloc(8 + 16 * LIMIT);
  M.midsolve(BigInt(raw), resultsPtr);

  const readInt32 = (p) => new Int32Array(mem.buffer, p, 1)[0];
  const readBoard = (p) => {
    const u = new Uint32Array(mem.buffer, p, 2);
    return (BigInt(u[0]) | (BigInt(u[1]) << 32n)).toString();
  };

  const num = readInt32(resultsPtr);
  const out = {};
  for (let i = 0; i < num; i++) {
    const base = resultsPtr + 8 + 16 * i;
    out[readBoard(base)] = readInt32(base + 8);
  }
  if (typeof M.free === 'function') M.free(resultsPtr);
  return out;
}
