// main.js
// UI + rendering + input handling for Pentago (1-player and 2-player modes).

import { PentagoGame } from './game.js';
import { getStone, parseBoard } from './board.js';
import { getPerfectValues } from './solver.js';
import { getHeuristicValues } from './heuristics.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

let game = new PentagoGame();
let playerMode = 1; // 1 = vs AI, 2 = local two players
let showHints = false;
let hintValues = null; // map of board name/raw -> value for current position's children
let thinking = false;
let thinkingMessage = 'Perfect AI thinking…';
let animating = false;
let rotationAnim = null; // { board, qx, qy, dir, progress }
let undoAnimLog = []; // one entry per completed move in history[1..]
let undoing = false;
let gameEpoch = 0;
let lastPlacement = null; // { row, col } in current displayed board coordinates
let statusError = null; // { msg, retry } when a solver call failed and left a degraded state

function currentGameRun() {
  return { game, epoch: gameEpoch };
}

function isCurrentGameRun(run) {
  return game === run.game && gameEpoch === run.epoch;
}

function setStatus(msg, { busy = false, error = false, retry = null } = {}) {
  statusEl.classList.toggle('busy', busy);
  statusEl.classList.toggle('error', error);
  statusEl.replaceChildren();
  if (busy) {
    statusEl.appendChild(createHtml('span', { class: 'spinner', 'aria-hidden': 'true' }));
  }
  statusEl.appendChild(document.createTextNode(msg));
  if (retry) {
    const btn = createHtml('button', { class: 'retry-inline', type: 'button' });
    btn.textContent = 'Retry';
    btn.addEventListener('click', retry);
    statusEl.appendChild(btn);
  }
}

// Show a persistent red error (survives re-renders until cleared or retried).
// `retry`, if given, renders a Retry button that clears the error and re-runs it.
function setError(msg, retry = null) {
  statusError = {
    msg,
    retry: retry ? () => { statusError = null; retry(); } : null,
  };
  render(); // render() calls updateStatus(), which now renders the error + Retry
}

function createHtml(el, attrs = {}) {
  const node = document.createElement(el);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function syncControls() {
  const busy = thinking || animating || undoing;
  // A move is only "finished" once both placement AND rotation are done.
  // While a placement is awaiting its rotation, undo must stay disabled.
  const midMove = !!(game && game.getStatus().inRotatePhase);
  const undoBtn = document.getElementById('btn-undo');
  const hintBtn = document.getElementById('btn-hint');
  const heurBtn = document.getElementById('btn-heur-move');
  if (undoBtn) undoBtn.disabled = busy || midMove;
  if (hintBtn) hintBtn.disabled = busy;
  if (heurBtn) heurBtn.disabled = busy || playerMode !== 2;
}

function updateStatus() {
  if (statusError) {
    setStatus(statusError.msg, { error: true, retry: statusError.retry });
    syncControls();
    return;
  }
  const s = game.getStatus();
  let text = s.message;
  if (s.count > 0 && !text.toLowerCase().includes('rotate')) {
    text += `  •  ${s.count} stones`;
  }
  if (thinking) text = thinkingMessage;
  setStatus(text, { busy: thinking });
  syncControls();
}

function clearSVG() {
  while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild);
}

function legendDotRadiusInSvg() {
  // Match the 10px legend dot diameter in board SVG coordinates.
  const boardPx = boardEl.getBoundingClientRect().width;
  const viewBoxWidth = boardEl.viewBox?.baseVal?.width || 7.2;
  if (!boardPx || !Number.isFinite(boardPx)) return 0.055;
  return (5 * viewBoxWidth) / boardPx;
}

function hintColor(value) {
  return value === 1 ? '#22c55e' : (value === 0 ? '#3b82f6' : '#ef4444');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

const inQuadrant = (r, c, qx, qy) =>
  Math.floor(r / 3) === qy && Math.floor(c / 3) === qx;

function rotateCell(row, col, qx, qy, dir) {
  if (!inQuadrant(row, col, qx, qy)) return { row, col };

  const baseR = qy * 3;
  const baseC = qx * 3;
  const localR = row - baseR;
  const localC = col - baseC;

  if (dir === 1) {
    return { row: baseR + (2 - localC), col: baseC + localR };
  }
  return { row: baseR + localC, col: baseC + (2 - localR) };
}

function getPlacedCell(beforeBoard, placeBoard) {
  for (let i = 0; i < 36; i++) {
    if (beforeBoard.grid[i] === 0 && placeBoard.grid[i] !== 0) {
      return { row: Math.floor(i / 6), col: i % 6 };
    }
  }
  return null;
}

async function playRotationAnimation(boardBefore, qx, qy, dir, durationMs = 220, isCancelled = null) {
  const start = performance.now();
  return new Promise(resolve => {
    const tick = (now) => {
      if (isCancelled?.()) {
        rotationAnim = null;
        resolve(false);
        return;
      }
      const t = Math.min(1, (now - start) / durationMs);
      rotationAnim = { board: boardBefore, qx, qy, dir, progress: t };
      render();
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        rotationAnim = null;
        resolve(true);
      }
    };
    requestAnimationFrame(tick);
  });
}

function deriveForwardTransition(prevBoard, finalBoard) {
  // Find decomposition of prev -> final as:
  // prev --place--> placeBoard --rotate?--> finalBoard
  const matches = [];
  for (const placeBoard of prevBoard.moves()) {
    if (placeBoard.name === finalBoard.name) {
      matches.push({ placeBoard, rotate: null });
      continue;
    }
    if (placeBoard.done) continue;
    for (const qx of [0, 1]) {
      for (const qy of [0, 1]) {
        for (const dir of [-1, 1]) {
          const r = placeBoard.rotate(qx, qy, dir);
          if (r.name === finalBoard.name) {
            matches.push({ placeBoard, rotate: { qx, qy, dir } });
          }
        }
      }
    }
  }
  // Some positions can be reached through multiple equivalent decompositions.
  // In that case, don't guess: caller should use a non-directional fallback animation.
  return matches.length === 1 ? matches[0] : null;
}

async function animateUndoTransition(prevBoard, currentBoard, moveMeta = null) {
  // Undo one full move (currentBoard -> prevBoard) as reverse of:
  // place then rotate  =>  rotate back then remove placed stone.
  let t = null;
  if (moveMeta?.rotate) {
    const r = moveMeta.rotate;
    t = {
      rotate: r,
      placeBoard: currentBoard.rotate(r.qx, r.qy, -r.dir),
    };
  }
  if (!t) {
    t = deriveForwardTransition(prevBoard, currentBoard);
  }

  // Start from current final board
  game.setTransientBoard(currentBoard, 'Undoing move…');
  render();
  await delay(70);

  if (t?.rotate) {
    // Reverse the rotation first
    animating = true;
    await playRotationAnimation(currentBoard, t.rotate.qx, t.rotate.qy, -t.rotate.dir, 180);
    animating = false;

    // Show board after reverse rotation (which is the place-only board)
    game.setTransientBoard(t.placeBoard, 'Undoing move…');
    render();
    await delay(90);
  }

  // Remove the placed stone (back to previous board).
  // If decomposition was ambiguous, this clean snap avoids showing an incorrect rotation.
  game.setTransientBoard(prevBoard, 'Undoing move…');
  render();
  await delay(90);
}

function create(el, attrs = {}, text = '') {
  const node = document.createElementNS(SVG_NS, el);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function getDisplayWinningLines(board) {
  // Compute wins in the same row/col space we render.
  const lines = [];
  const stone = (r, c) => getStone(board, r, c);

  // horizontal
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c <= 1; c++) {
      const p = stone(r, c);
      if (p && stone(r, c + 1) === p && stone(r, c + 2) === p && stone(r, c + 3) === p && stone(r, c + 4) === p) {
        lines.push([[r, c], [r, c + 4], p]);
      }
    }
  }
  // vertical
  for (let c = 0; c < 6; c++) {
    for (let r = 0; r <= 1; r++) {
      const p = stone(r, c);
      if (p && stone(r + 1, c) === p && stone(r + 2, c) === p && stone(r + 3, c) === p && stone(r + 4, c) === p) {
        lines.push([[r, c], [r + 4, c], p]);
      }
    }
  }
  // diagonal down-right
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c <= 1; c++) {
      const p = stone(r, c);
      if (p && stone(r + 1, c + 1) === p && stone(r + 2, c + 2) === p && stone(r + 3, c + 3) === p && stone(r + 4, c + 4) === p) {
        lines.push([[r, c], [r + 4, c + 4], p]);
      }
    }
  }
  // diagonal down-left
  for (let r = 0; r <= 1; r++) {
    for (let c = 4; c < 6; c++) {
      const p = stone(r, c);
      if (p && stone(r + 1, c - 1) === p && stone(r + 2, c - 2) === p && stone(r + 3, c - 3) === p && stone(r + 4, c - 4) === p) {
        lines.push([[r, c], [r + 4, c - 4], p]);
      }
    }
  }

  return lines;
}

// Geometry - the 6x6 board is laid out with cell centers at (QUAD_BASE + c + 0.5, QUAD_BASE + r + 0.5)
// i.e. the board spans from QUAD_BASE to QUAD_BASE+6.
// viewBox is set to give a little breathing room around it for the rotation arrows.
const R = 0.42;          // stone radius
const QUAD_BASE = -3;    // left/top edge of top-left quadrant
const QUAD_SIZE = 3;     // each quadrant is 3x3 cells

// Rotator arrow geometry (tuned to fit tight viewBox while still being clickable)
const ROT_R = 0.95;
const ROT_TH = 0.16;
const ROT_ARROW = 0.26;
const SEL_R = 1.18;      // clickable radius — keep reasonably close to visible arrow so nothing clips at corners

function render() {
  clearSVG();
  const b = rotationAnim ? rotationAnim.board : game.getBoard();
  const s = game.getStatus();

  const animQx = rotationAnim ? rotationAnim.qx : -1;
  const animQy = rotationAnim ? rotationAnim.qy : -1;
  const isAnimQuadrant = (qx, qy) => qx === animQx && qy === animQy;

  // Static quadrants (tan + inner lines). If animating, leave active quadrant for rotating overlay.
  for (let qx = 0; qx < 2; qx++) {
    for (let qy = 0; qy < 2; qy++) {
      if (isAnimQuadrant(qx, qy)) continue;
      const bx = QUAD_BASE + qx * QUAD_SIZE;
      const by = QUAD_BASE + qy * QUAD_SIZE;
      boardEl.appendChild(create('rect', {
        x: bx, y: by, width: QUAD_SIZE, height: QUAD_SIZE,
        fill: '#d2b48c', stroke: '#3a2f1f', 'stroke-width': 0.035
      }));
      const innerColor = '#8a6f47';
      // vertical
      boardEl.appendChild(create('line', {
        x1: bx + 1, y1: by + 0.08, x2: bx + 1, y2: by + QUAD_SIZE - 0.08,
        stroke: innerColor, 'stroke-width': 0.028
      }));
      boardEl.appendChild(create('line', {
        x1: bx + 2, y1: by + 0.08, x2: bx + 2, y2: by + QUAD_SIZE - 0.08,
        stroke: innerColor, 'stroke-width': 0.028
      }));
      // horizontal
      boardEl.appendChild(create('line', {
        x1: bx + 0.08, y1: by + 1, x2: bx + QUAD_SIZE - 0.08, y2: by + 1,
        stroke: innerColor, 'stroke-width': 0.028
      }));
      boardEl.appendChild(create('line', {
        x1: bx + 0.08, y1: by + 2, x2: bx + QUAD_SIZE - 0.08, y2: by + 2,
        stroke: innerColor, 'stroke-width': 0.028
      }));
    }
  }

  // Dark cross (the "cuts" between quadrants)
  const crossColor = '#3a2f1f';
  const crossW = 0.13;
  boardEl.appendChild(create('rect', {
    x: -crossW/2, y: QUAD_BASE, width: crossW, height: 6,
    fill: crossColor
  }));
  boardEl.appendChild(create('rect', {
    x: QUAD_BASE, y: -crossW/2, width: 6, height: crossW,
    fill: crossColor
  }));

  // Stones
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      if (rotationAnim && inQuadrant(r, c, animQx, animQy)) continue;
      const val = getStone(b, r, c);
      if (val === 0) continue;
      const cx = QUAD_BASE + c + 0.5;
      const cy = QUAD_BASE + r + 0.5;
      const color = val === 1 ? '#111' : '#f8f8f8';
      boardEl.appendChild(create('circle', {
        cx, cy, r: R,
        fill: color, stroke: '#222', 'stroke-width': 0.05
      }));
    }
  }

  // Rotating quadrant overlay for animation
  if (rotationAnim) {
    const { qx, qy, dir, progress } = rotationAnim;
    const bx = QUAD_BASE + qx * QUAD_SIZE;
    const by = QUAD_BASE + qy * QUAD_SIZE;
    const cx = bx + 1.5;
    const cy = by + 1.5;
    const angle = (dir === 1 ? -90 : 90) * progress;

    const g = create('g', {
      transform: `translate(${cx} ${cy}) rotate(${angle}) translate(${-cx} ${-cy})`
    });

    g.appendChild(create('rect', {
      x: bx, y: by, width: QUAD_SIZE, height: QUAD_SIZE,
      fill: '#d2b48c', stroke: '#3a2f1f', 'stroke-width': 0.035
    }));
    const innerColor = '#8a6f47';
    g.appendChild(create('line', {
      x1: bx + 1, y1: by + 0.08, x2: bx + 1, y2: by + QUAD_SIZE - 0.08,
      stroke: innerColor, 'stroke-width': 0.028
    }));
    g.appendChild(create('line', {
      x1: bx + 2, y1: by + 0.08, x2: bx + 2, y2: by + QUAD_SIZE - 0.08,
      stroke: innerColor, 'stroke-width': 0.028
    }));
    g.appendChild(create('line', {
      x1: bx + 0.08, y1: by + 1, x2: bx + QUAD_SIZE - 0.08, y2: by + 1,
      stroke: innerColor, 'stroke-width': 0.028
    }));
    g.appendChild(create('line', {
      x1: bx + 0.08, y1: by + 2, x2: bx + QUAD_SIZE - 0.08, y2: by + 2,
      stroke: innerColor, 'stroke-width': 0.028
    }));

    for (let r = qy * 3; r < qy * 3 + 3; r++) {
      for (let c = qx * 3; c < qx * 3 + 3; c++) {
        const val = getStone(b, r, c);
        if (!val) continue;
        const sx = QUAD_BASE + c + 0.5;
        const sy = QUAD_BASE + r + 0.5;
        const color = val === 1 ? '#111' : '#f8f8f8';
        g.appendChild(create('circle', {
          cx: sx, cy: sy, r: R,
          fill: color, stroke: '#222', 'stroke-width': 0.05
        }));
      }
    }
    boardEl.appendChild(g);
  }

  // Five-in-a-row highlights (thin, precise line in displayed board coordinates)
  for (const [[r0, c0], [r1, c1]] of getDisplayWinningLines(b)) {
    const x0 = QUAD_BASE + c0 + 0.5;
    const y0 = QUAD_BASE + r0 + 0.5;
    const x1 = QUAD_BASE + c1 + 0.5;
    const y1 = QUAD_BASE + r1 + 0.5;
    boardEl.appendChild(create('line', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: '#facc15',
      'stroke-width': 0.12,
      'stroke-linecap': 'round',
      'pointer-events': 'none'
    }));
  }

  if (lastPlacement && getStone(b, lastPlacement.row, lastPlacement.col)) {
    boardEl.appendChild(create('circle', {
      cx: QUAD_BASE + lastPlacement.col + 0.5,
      cy: QUAD_BASE + lastPlacement.row + 0.5,
      r: R * 1.28,
      fill: 'none',
      stroke: '#facc15',
      'stroke-width': 0.08,
      class: 'last-placement-ring',
      'pointer-events': 'none'
    }));
  }

  const humanTurn = game.isHumanTurn();
  const canPlace = humanTurn && !b.middle && !s.gameOver && !thinking && !animating && !rotationAnim;
  const canRotate = humanTurn && b.middle && !s.gameOver && !thinking && !animating && !rotationAnim;

  // Empty cells (clickable for place)
  if (canPlace) {
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        if (getStone(b, r, c) !== 0) continue;
        const cx = QUAD_BASE + c + 0.5;
        const cy = QUAD_BASE + r + 0.5;

        const spot = create('circle', {
          cx, cy, r: R * 1.15,
          fill: 'transparent',
          'fill-opacity': 0,
          stroke: 'none',
          class: 'clickable'
        });
        spot.addEventListener('click', () => onPlace(r, c));
        spot.addEventListener('mouseenter', () => {
          spot.setAttribute('fill', humanColor());
          spot.setAttribute('fill-opacity', getStonePreviewOpacity());
        });
        spot.addEventListener('mouseleave', () => {
          spot.setAttribute('fill', 'transparent');
          spot.setAttribute('fill-opacity', '0');
        });
        boardEl.appendChild(spot);
      }
    }
  }

  // Rotation arrows
  if (canRotate) {
    const hintRadius = legendDotRadiusInSvg();
    for (let qx = 0; qx < 2; qx++) {
      for (let qy = 0; qy < 2; qy++) {
        for (const dir of [-1, 1]) {
          const rot = makeRotator(qx, qy, dir);
          const pathEl = create('path', {
            d: rot.path,
            fill: '#5c4630',
            'fill-opacity': 0.95,
            stroke: '#111',
            'stroke-width': 0.06,
            class: 'rotator'
          });
          const hit = create('path', {
            d: rot.select,
            fill: 'transparent',
            'fill-opacity': 0,
            class: 'rotator-hit'
          });

          // UI arrow orientation and board rotation direction were inverted.
          // Flip direction at click boundary so visual arrow matches actual rotation.
          hit.addEventListener('click', () => onRotate(qx, qy, -dir));
          pathEl.addEventListener('click', () => onRotate(qx, qy, -dir));

          pathEl.addEventListener('mouseenter', () => {
            pathEl.setAttribute('fill', '#111');
            pathEl.setAttribute('fill-opacity', '1');
          });
          pathEl.addEventListener('mouseleave', () => {
            pathEl.setAttribute('fill', '#5c4630');
            pathEl.setAttribute('fill-opacity', '0.95');
          });

          boardEl.appendChild(hit);
          boardEl.appendChild(pathEl);

          if (showHints && hintValues) {
            // Clicking this visual arrow executes board rotation with -dir.
            const finalBoard = b.rotate(qx, qy, -dir);
            const childVal = hintValues[finalBoard.name] ?? hintValues[String(finalBoard.raw)] ?? hintValues[finalBoard.raw];
            if (childVal !== undefined) {
              // Solver values are for player-to-move on the child board (after rotation),
              // i.e. the opponent. Flip sign so arrow hints reflect the current rotator.
              const val = -childVal;
              const hintDot = create('circle', {
                cx: rot.hintX,
                cy: rot.hintY,
                r: hintRadius,
                fill: hintColor(val),
                stroke: '#111',
                'stroke-width': 0.03,
                'pointer-events': 'none'
              });
              // Draw above arrow graphics so the dot is always visible.
              boardEl.appendChild(hintDot);
            }
          }
        }
      }
    }
  }

  // Optional perfect-play hint labels (colored dots on empty playable cells)
  if (showHints && hintValues && humanTurn && !s.gameOver && !b.middle) {
    const hintRadius = legendDotRadiusInSvg();
    const children = b.moves();
    for (const ch of children) {
      const val = hintValues[ch.name] ?? hintValues[String(ch.raw)] ?? hintValues[ch.raw];
      if (val === undefined) continue;

      // Place one dot exactly where this child placed a stone.
      let placedRow = null;
      let placedCol = null;
      for (let i = 0; i < 36; i++) {
        if (ch.grid[i] !== b.grid[i] && ch.grid[i] !== 0) {
          placedRow = Math.floor(i / 6);
          placedCol = i % 6;
          break;
        }
      }
      if (placedRow === null || placedCol === null) continue;

      const cx = QUAD_BASE + placedCol + 0.5;
      const cy = QUAD_BASE + placedRow + 0.5;

      const color = hintColor(val);
      const dot = create('circle', {
        cx, cy, r: hintRadius,
        fill: color, stroke: '#111', 'stroke-width': 0.03,
        'pointer-events': 'none'
      });
      boardEl.appendChild(dot);
    }
  }

  // (Game over message is shown in the status bar below the board)

  updateStatus();
}

function humanColor() {
  // Color for interactive elements for the human
  const current = game.getBoard().currentPlayer;
  return current === 1 ? '#050505' : '#ffffff';
}

function getStonePreviewOpacity() {
  return game.getBoard().currentPlayer === 1 ? '0.82' : '0.9';
}

function makeRotator(qx, qy, d) {
  // Anchor the rotation arc just outside the quadrant.
  // Quadrant centers are at QUAD_BASE + 1.5 + q*3
  const qcx = QUAD_BASE + qx * QUAD_SIZE + 1.5;
  const qcy = QUAD_BASE + qy * QUAD_SIZE + 1.5;

  const dx = qx ? 1 : -1;   // outward in x for this quadrant
  const dy = qy ? 1 : -1;   // outward in y

  // Push the arc center outward from the quadrant center, but closer to the actual corner
  // so the full curved arrows (and their hit areas) stay inside the viewBox.
  const outward = 0.82;
  const cx = qcx + dx * outward;
  const cy = qcy + dy * outward;

  const r = ROT_R;
  const a = ROT_ARROW;
  const h = ROT_TH / 2;

  let xa, ya, xb, yb;
  if ((d > 0) ^ (qx === qy)) {
    xa = 0; ya = dy; xb = dx; yb = 0;
  } else {
    xa = dx; ya = 0; xb = 0; yb = dy;
  }

  const point = (rr, t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [cx + rr * (c * xa + s * xb), cy + rr * (c * ya + s * yb)];
  };

  const t0 = 0.82, t1 = Math.PI / 2, t2 = t1 + a / r;
  const sa = SEL_R;

  const select = 'M' + point(0, 0) +
    ' L' + point(sa, t2) +
    ' A' + sa + ',' + sa + ' 0 0 ' + (d > 0 ? '0' : '1') + ' ' + point(sa, t0) + ' z';

  const path = 'M' + point(r - h, t0) +
    ' A' + (r - h) + ',' + (r - h) + ' 0 0 ' + (d > 0 ? '1' : '0') + ' ' + point(r - h, t1) +
    ' L' + point(r - a, t1) +
    ' L' + point(r, t2) +
    ' L' + point(r + a, t1) +
    ' L' + point(r + h, t1) +
    ' A' + (r + h) + ',' + (r + h) + ' 0 0 ' + (d > 0 ? '0' : '1') + ' ' + point(r + h, t0) + ' z';

  // Keep hint point on the visible arrow body and away from the SVG clipping edge.
  const hint = point(r - h * 0.2, t1 - 0.2);

  return { path, select, qx, qy, d, hintX: hint[0], hintY: hint[1] };
}

async function onPlace(row, col) {
  if (thinking || animating || !game.humanPlace(row, col)) return;
  statusError = null;
  lastPlacement = { row, col };
  hintValues = null;
  render();

  // If the place completed the game (5 in a row on place), AI doesn't play.
  // Record a completed (place-only) move so undo stays aligned with history.
  if (game.getStatus().gameOver) {
    undoAnimLog.push({ rotate: null });
    return;
  }

  // If we are now in rotate phase, wait for human to rotate
  if (game.getBoard().middle) {
    if (showHints) {
      refreshHints();
    }
    return;
  }

  // Otherwise (should not normally happen here), let AI respond
  if (playerMode === 1) {
    await doAiTurn();
  }
}

async function onRotate(qx, qy, dir) {
  if (thinking || animating) return;
  const before = game.getBoard();
  if (!game.isHumanTurn() || !before.middle || game.getStatus().gameOver) return;

  statusError = null;
  animating = true;
  await playRotationAnimation(before, qx, qy, dir, 200);
  const ok = game.humanRotate(qx, qy, dir);
  animating = false;
  if (!ok) {
    render();
    return;
  }
  if (lastPlacement) {
    lastPlacement = rotateCell(lastPlacement.row, lastPlacement.col, qx, qy, dir);
  }
  undoAnimLog.push({ rotate: { qx, qy, dir } });

  render();
  if (game.getStatus().gameOver) return;
  if (playerMode === 1) {
    await doAiTurn();
  } else if (showHints) {
    hintValues = null;
    refreshHints({ blockInput: true });
  }
}

const doAiTurn = () => runComputerMove({
  mode: 1, thinkMsg: 'Perfect AI thinking…', placeMsg: 'AI places…',
  errPrefix: 'Error talking to perfect solver: ',
});

// Compute and play a full computer move (perfect AI in 1p, "AI Move" in 2p),
// animating the placement then the rotation. Aborts cleanly if the game run
// changes (new game / mode switch / undo) while thinking or animating.
async function runComputerMove({ mode, thinkMsg, placeMsg, errPrefix }) {
  if (playerMode !== mode || thinking || animating || game.getStatus().gameOver) return;
  if (mode === 1 && game.isHumanTurn()) return;
  const run = currentGameRun();

  // Clear old hints so we don't display stale dots while thinking.
  statusError = null;
  hintValues = null;
  thinking = true;
  thinkingMessage = thinkMsg;
  updateStatus();
  render();
  await nextPaint();

  let failed = false;
  try {
    const before = game.getBoard();
    const plan = await findComputerPlan(before);
    if (!isCurrentGameRun(run) || game.getBoard().name !== before.name || playerMode !== mode) return;
    if (!plan) return;
    let placedCell = plan.placeBoard ? getPlacedCell(before, plan.placeBoard) : null;

    // Step 1: show the placement (stone appears) before rotation.
    if (plan.placeBoard && plan.placeBoard.name !== before.name) {
      lastPlacement = placedCell;
      game.setTransientBoard(plan.placeBoard, placeMsg);
      render();
      await delay(130);
      if (!isCurrentGameRun(run)) return;
    }

    // Step 2: animate the rotation (if any), then commit the final board.
    if (plan.rotate) {
      animating = true;
      const completed = await playRotationAnimation(
        plan.placeBoard,
        plan.rotate.qx,
        plan.rotate.qy,
        plan.rotate.dir,
        230,
        () => !isCurrentGameRun(run)
      );
      if (!completed || !isCurrentGameRun(run)) return;
      animating = false;
    }

    if (!isCurrentGameRun(run) || game.getBoard().name !== (plan.placeBoard?.name ?? before.name)) return;
    if (placedCell && plan.rotate) {
      placedCell = rotateCell(placedCell.row, placedCell.col, plan.rotate.qx, plan.rotate.qy, plan.rotate.dir);
    }
    lastPlacement = placedCell;
    game.commitAiMove(plan.finalBoard);
    undoAnimLog.push({ rotate: plan.rotate ?? null });
  } catch (e) {
    console.error(e);
    failed = true;
    if (isCurrentGameRun(run)) {
      // The move didn't happen; offer a red error + Retry rather than a dead state.
      animating = false;
      thinking = false;
      setError(errPrefix + e.message, () => runComputerMove({ mode, thinkMsg, placeMsg, errPrefix }));
    }
  } finally {
    if (isCurrentGameRun(run)) {
      animating = false;
      thinking = false;
      syncControls();
    }
  }
  if (!isCurrentGameRun(run) || failed) return;
  hintValues = null;
  if (showHints && !game.getStatus().gameOver) {
    refreshHints({ blockInput: true });
  } else {
    render();
  }
}

async function refreshHints({ blockInput = false } = {}) {
  statusError = null;
  if (!showHints) {
    hintValues = null;
    render();
    return;
  }
  const run = currentGameRun();
  const b = game.getBoard();
  if (b.done) {
    hintValues = null;
    render();
    return;
  }
  const iBlocked = blockInput && !thinking; // did this call acquire the input block?
  const previousThinkingMessage = thinkingMessage;
  if (blockInput) {
    if (iBlocked) thinking = true;
    thinkingMessage = 'Finding hint…';
    updateStatus();
    render();
  }
  try {
    await nextPaint();
    const values = await getPerfectValues(b);
    if (isCurrentGameRun(run) && game.getBoard().name === b.name && showHints) {
      hintValues = values;
    }
  } catch (e) {
    console.warn('Could not fetch hints:', e);
    // Only surface an error for the position we're still sitting on. A superseded
    // fetch (run changed / moved on) is not a failure, so it stays silent.
    if (isCurrentGameRun(run) && game.getBoard().name === b.name && showHints) {
      hintValues = null;
      if (blockInput && iBlocked) thinking = false;
      setError('Couldn’t fetch hints.', () => refreshHints({ blockInput: true }));
    }
  } finally {
    // Always release the input block this call acquired once our run settles,
    // so a slow or failed hint lookup can never leave the controls stuck.
    // (A superseding run resets its own flags, so we skip when no longer current.)
    if (blockInput && isCurrentGameRun(run)) {
      if (iBlocked) thinking = false;
      else thinkingMessage = previousThinkingMessage;
      syncControls();
    }
  }
  render();
}

function valueForChild(values, child) {
  return values[child.name] ?? values[String(child.raw)] ?? values[child.raw];
}

function bestKeysFromPerfectValues(board, values) {
  const children = board.moves();
  if (!children.length) return [];

  // Place phase: maximize value for current mover.
  // Rotate phase: child values are for opponent-to-move, so minimize.
  const maximize = !board.middle;
  let best = maximize ? -99 : 99;
  let keys = [];

  for (const ch of children) {
    const v = valueForChild(values, ch);
    if (v === undefined) continue;

    if ((maximize && v > best) || (!maximize && v < best)) {
      best = v;
      keys = [ch.name];
    } else if (v === best) {
      keys.push(ch.name);
    }
  }

  return keys;
}

function childByKey(board, key) {
  const k = String(key);
  for (const ch of board.moves()) {
    if (ch.name === k || String(ch.raw) === k) return ch;
  }
  return null;
}

// Find the rotation {qx, qy, dir} that turns fromBoard into toBoard, or null.
function findRotation(fromBoard, toBoard) {
  for (const qx of [0, 1]) {
    for (const qy of [0, 1]) {
      for (const dir of [-1, 1]) {
        if (fromBoard.rotate(qx, qy, dir).name === toBoard.name) return { qx, qy, dir };
      }
    }
  }
  return null;
}

// Pick the best child of `board`: perfect play first, heuristic tiebreak.
async function chooseChild(board) {
  const values = await getPerfectValues(board);
  const bestKeys = bestKeysFromPerfectValues(board, values);
  if (!bestKeys.length) return null;
  if (bestKeys.length === 1) return childByKey(board, bestKeys[0]);

  const heurKey = Object.keys(await getHeuristicValues(board, bestKeys))[0];
  return childByKey(board, heurKey) ?? childByKey(board, bestKeys[0]);
}

// Plan a full computer move: { placeBoard, finalBoard, rotate | null }.
async function findComputerPlan(board) {
  if (board.done) return null;

  if (board.middle) {
    const finalBoard = await chooseChild(board);
    return finalBoard ? { placeBoard: board, finalBoard, rotate: findRotation(board, finalBoard) } : null;
  }

  const placeBoard = await chooseChild(board);
  if (!placeBoard) return null;
  if (placeBoard.done) return { placeBoard, finalBoard: placeBoard, rotate: null };

  const finalBoard = await chooseChild(placeBoard);
  return finalBoard ? { placeBoard, finalBoard, rotate: findRotation(placeBoard, finalBoard) } : null;
}

function bindUI() {
  document.getElementById('mode-1p').addEventListener('change', (e) => {
    if (e.target.checked) toggleMode(1);
  });
  document.getElementById('mode-2p').addEventListener('change', (e) => {
    if (e.target.checked) toggleMode(2);
  });
  document.getElementById('btn-heur-move').addEventListener('click', doHeuristicTurn);
  document.getElementById('btn-new').addEventListener('click', () => startNew(true));
  document.getElementById('btn-new-white').addEventListener('click', () => startNew(false));
  document.getElementById('btn-undo').addEventListener('click', doUndo);
  document.getElementById('btn-hint').addEventListener('click', toggleHints);

  // Keyboard: u = undo, h = hints, n = new
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key.toLowerCase() === 'u') doUndo();
    if (e.key.toLowerCase() === 'h') toggleHints();
    if (e.key.toLowerCase() === 'n') startNew(true);
  });
}

function updateModeUI() {
  const mode1 = document.getElementById('mode-1p');
  const mode2 = document.getElementById('mode-2p');
  const heurBtn = document.getElementById('btn-heur-move');
  const newWhiteBtn = document.getElementById('btn-new-white');
  mode1.checked = playerMode === 1;
  mode2.checked = playerMode === 2;
  newWhiteBtn.style.display = playerMode === 2 ? 'none' : '';
  heurBtn.style.display = playerMode === 2 ? '' : 'none';
  heurBtn.disabled = playerMode !== 2;
  document.getElementById('btn-new').textContent = playerMode === 2 ? 'New Game' : 'New Game (You Black)';
}

function toggleMode(mode = (playerMode === 1 ? 2 : 1)) {
  playerMode = mode;
  updateModeUI();
  startNew(true);
}

const doHeuristicTurn = () => runComputerMove({
  mode: 2, thinkMsg: 'Finding move…', placeMsg: 'Heuristic places…',
  errPrefix: 'Heuristic move failed: ',
});

function startNew(humanIsBlack) {
  gameEpoch++;
  game = new PentagoGame();
  game.reset(humanIsBlack, playerMode);
  undoAnimLog = [];
  hintValues = null;
  lastPlacement = null;
  statusError = null;
  thinking = false;
  animating = false;
  rotationAnim = null;

  // If human chose to play second (white), AI (black) moves first
  render();
  if (showHints && game.isHumanTurn() && !game.getStatus().gameOver) {
    refreshHints();
  }
  if (playerMode === 1 && !game.isHumanTurn() && !game.getStatus().gameOver) {
    // fire and forget
    doAiTurn();
  }
}

async function doUndo() {
  if (undoing || thinking || animating) return;
  // Don't undo a half-finished move (placement done, rotation still pending).
  if (game.getStatus().inRotatePhase) return;
  if (game.history.length <= 1) return;
  undoing = true;
  try {
  // Undo behavior:
  // - 2-player mode: undo one move (1 ply).
  // - 1-player mode: undo back to the human's turn. We can't rely on
  //   game.isHumanTurn() here because it returns false once the game is over,
  //   which would leave us stranded on the AI's turn after undoing a win.
  const originalHistory = game.history.slice();
  const originalAnimLog = undoAnimLog.slice();
  const maxPop = Math.max(0, originalHistory.length - 1);

  const humanToMoveOn = (name) => {
    const b = parseBoard(name);
    const currentIsBlack = !b.turn; // turn false = black to move
    return (currentIsBlack && game.humanIsBlack) || (!currentIsBlack && !game.humanIsBlack);
  };

  let popCount;
  if (playerMode === 2) {
    popCount = Math.min(1, maxPop);
  } else {
    // Undo at least one ply, then keep going until the human is to move.
    popCount = Math.min(1, maxPop);
    while (popCount < maxPop && !humanToMoveOn(originalHistory[originalHistory.length - 1 - popCount])) {
      popCount++;
    }
  }
  const targetHistory = originalHistory.slice(0, originalHistory.length - popCount);
  const targetAnimLog = originalAnimLog.slice(0, Math.max(0, originalAnimLog.length - popCount));
  const prevName = targetHistory[targetHistory.length - 1];

  // Animate each undone ply from newest -> oldest
  for (let i = originalHistory.length - 1; i >= targetHistory.length; i--) {
    const currentBoard = parseBoard(originalHistory[i]);
    const previousBoard = parseBoard(originalHistory[i - 1]);
    const moveMeta = originalAnimLog[i - 1] || null;
    await animateUndoTransition(previousBoard, currentBoard, moveMeta);
  }

  const newGame = new PentagoGame();
  newGame.reset(game.humanIsBlack, playerMode);
  newGame.board = parseBoard(prevName);
  newGame.history = targetHistory.slice();
  newGame.gameOver = newGame.board.done;
  newGame.pendingPlace = null;
  if (playerMode === 2) {
    newGame.message = newGame.board.currentPlayer === 1 ? 'Black to move' : 'White to move';
  } else {
    newGame.message = newGame.isHumanTurn() ? 'Your turn' : 'Perfect AI is thinking...';
  }

  game = newGame;
  gameEpoch++;
  undoAnimLog = targetAnimLog.slice();
  hintValues = null;
  lastPlacement = null;
  statusError = null;
  // Clear any transient busy flags so an undo always lands in a clean, enabled
  // state (mirrors startNew); the hint refresh below manages its own flag.
  thinking = false;
  animating = false;
  rotationAnim = null;
  if (showHints && game.isHumanTurn() && !game.getStatus().gameOver) {
    refreshHints({ blockInput: true });
  } else {
    render();
  }
  } finally {
    undoing = false;
  }
}

function toggleHints() {
  showHints = !showHints;
  if (showHints) {
    refreshHints();
  } else {
    hintValues = null;
    statusError = null; // a stale hint error is irrelevant once hints are off
    render();
  }
}

async function init() {
  bindUI();
  updateModeUI();
  render();

  // If the human is black, they start. Nothing else.
  // If someone wants AI to start, they use the "You White" button.
  updateStatus();
  if (showHints && game.isHumanTurn() && !game.getStatus().gameOver) {
    refreshHints();
  }
}

init().catch(err => {
  console.error(err);
  setStatus('Failed to initialize: ' + err.message, { error: true });
});
