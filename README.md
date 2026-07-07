# Pentago • Solved AI

A clean, hostable, single-player Pentago game (human vs perfect computer) that reuses the strongly solved results from https://perfect-pentago.net.

## How it works (zero/low cost)

- **Early game (0–17 stones)**: The app calls the public Cloud Function API from the original project. This uses their 3.7 TB perfect database.
- **Late game (18+ stones)**: The official `mid.wasm` (from Geoffrey Irving) runs entirely in the browser. No database, no server.


## Files

- `index.html` – the page
- `style.css`
- `main.js` – UI, rendering, input handling, game orchestration
- `game.js` – high-level game state and flow
- `board.js` – board model, move generation, parsing
- `solver.js` – perfect play (API for early game, WASM for 18+), caching
- `wasm-solve.js` – shared WebAssembly midgame solver
- `mid-worker.js` – Web Worker for responsive WASM solves
- `heuristics.js` – fast local move selection
- `mid.wasm` – the official midgame perfect solver (vendored, ~11 KB)
- `favicon.svg`

## Run locally

Simplest:

```bash
cd C:\Personal\Pentago
# Use any static file server, e.g.
npx serve .
# or
python -m http.server 8080
```

Open http://localhost:8080

## Notes & respect

- The public API is intended for light / personal use. If you make a very popular public site, consider emailing the author or adding caching/throttling.
- The WASM solver takes ~1–8 seconds on 18-stone positions (much faster later). The UI shows "thinking".
- First player has a forced win with perfect play.

Enjoy!
