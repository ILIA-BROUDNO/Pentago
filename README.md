# Pentago • Perfect Single Player (No Backend)

A clean, hostable, single-player Pentago game (human vs perfect computer) that reuses the strongly solved results from https://perfect-pentago.net.

## How it works (zero/low cost)

- **Early game (0–17 stones)**: The app calls the public Cloud Function API from the original project. This uses their 3.7 TB perfect database.
- **Late game (18+ stones)**: The official `mid.wasm` (from Geoffrey Irving) runs entirely in the browser. No database, no server.

You do **not** host the 3.7 TB data. You only make light API calls for the opening/midgame and do heavy lifting client-side with WASM.

## Files

- `index.html` – the page
- `style.css`
- `main.js` – UI, SVG board, input
- `game.js` – game flow, human vs AI turns
- `board.js` – board representation + move generation
- `solver.js` – chooses between API and WASM automatically
- `mid.wasm` – the official midgame perfect solver (vendored, ~11 KB)

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

## Deploy (free)

- GitHub Pages (free)
- Netlify (drag folder or git)
- Vercel
- Cloudflare Pages
- Any static host

Just upload the whole folder (including `mid.wasm`).

## Notes & respect

- The public API is intended for light / personal use. If you make a very popular public site, consider emailing the author or adding caching/throttling.
- The WASM solver takes ~1–8 seconds on 18-stone positions (much faster later). The UI shows "thinking".
- First player has a forced win with perfect play.

Enjoy!
