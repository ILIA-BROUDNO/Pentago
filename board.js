// board.js
// Core Pentago board representation and move generation.
// Ported/adapted from https://github.com/girving/pentago web/client/src/board.js
// All computation is pure client-side.

const six = [0, 1, 2, 3, 4, 5];
const big = BigInt;

const flatMap2 = (zs, f) => zs.flatMap(x => zs.flatMap(y => f(x, y)));

const gridMap = f =>
  flatMap2(six.map(big), (x, y) => [
    f(x, y, 65536n ** (x / 3n * 2n + y / 3n), 3n ** (x % 3n * 3n + y % 3n))
  ]);

const assert = (cond, name) => {
  if (!cond) throw new Error('Invalid board: ' + name);
};

// Precompute all 5-in-a-row rays (winning lines)
const winRays = flatMap2(six, (x, y) =>
  [[0, 4], [1, 0], [1, 4], [1, -4]].flatMap(([a, b]) => {
    if (x + 4 * a < 6 && 0 <= y + b && y + b < 6) {
      return [[0, 1, 2, 3, 4].map(i => 6 * (x + i * a) + y + Math.floor((i * b) / 4))];
    }
    return [];
  })
);

export class Board {
  constructor(grid, middle) {
    // grid: number[36] with 0=empty, 1=black, 2=white
    let stones = 0n;
    let count = 0;
    let shift = 0;

    gridMap((x, y, q, p) => {
      const s = grid[6 * Number(x) + Number(y)];
      stones += big(s) * p * q;
      count += s ? 1 : 0;
      shift += s & 2;
    });

    const name = stones + (middle ? 'm' : '');
    const turn = (count - shift) !== (middle ? 1 : 0); // false = black(1) to move, true = white(2)

    const place = (x, y) => {
      if (grid[6 * x + y] !== 0) throw new Error('Cell occupied');
      const g = grid.slice();
      g[6 * x + y] = turn ? 2 : 1;
      return new Board(g, 1);
    };

    const rotate = (qx, qy, d) => {
      // Rotate one 3x3 quadrant.
      // qx: 0 left, 1 right
      // qy: 0 top,  1 bottom
      // d:  1 = left (CCW), -1 = right (CW)
      const g = grid.slice();
      const baseR = qy * 3;
      const baseC = qx * 3;

      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const src = (baseR + r) * 6 + (baseC + c);
          let dstR, dstC;
          if (d === 1) { // CCW
            dstR = baseR + (2 - c);
            dstC = baseC + r;
          } else { // CW
            dstR = baseR + c;
            dstC = baseC + (2 - r);
          }
          g[dstR * 6 + dstC] = grid[src];
        }
      }
      return new Board(g, 0);
    };

    const won = (side) => winRays.some(ray => ray.every(p => (grid[p] & (side + 1)) !== 0));

    this.grid = grid;
    this.middle = !!middle;
    this.name = name;
    this.raw = stones | (big(middle ? 1 : 0) << 63n);
    this.turn = turn;           // false=black to move, true=white
    this.count = count;
    this.place = place;
    this.rotate = rotate;

    const blackWin = won(0);
    const whiteWin = won(1);
    this.done = blackWin || whiteWin || (count === 36 && !middle);

    if (this.done) {
      if (blackWin && whiteWin) this.value = 0;
      else if (blackWin) this.value = turn ? -1 : 1;  // relative to who would have moved?
      else if (whiteWin) this.value = turn ? 1 : -1;
      else this.value = 0;
    } else {
      this.value = 0;
    }

    this.moves = () => {
      if (this.middle) {
        return flatMap2([0, 1], (qx, qy) => [-1, 1].map(d => rotate(qx, qy, d)));
      }
      return flatMap2(six, (x, y) => (grid[6 * Number(x) + Number(y)] ? [] : [place(Number(x), Number(y))]));
    };

    this.fives = winRays.flatMap(ray => {
      const c = grid[ray[0]];
      if (c && ray.every(p => grid[p] === c)) {
        return [ray.map(p => [Math.floor((p - (p % 6)) / 6), p % 6])];
      }
      return [];
    });
  }

  get currentPlayer() {
    return this.turn ? 2 : 1; // 1=black, 2=white
  }

  clone() {
    return new Board(this.grid.slice(), this.middle);
  }
}

export function parseBoard(input) {
  let m = String(input).match(/^(\d+)(m?)$/);
  if (!m) {
    // try raw
    const n = BigInt(input);
    const middleBit = (n >> 63n) !== 0n;
    const stones = n & ((1n << 63n) - 1n);
    m = [null, stones.toString(), middleBit ? 'm' : ''];
  }
  assert(m, input);
  const stones = big(m[1]);
  const grid = gridMap((x, y, q, p) => {
    const val = Number((stones / q) % 32768n / p % 3n);
    return val;
  });
  return new Board(grid, !!m[2] || (stones >> 63n) !== 0n);
}

export const START_BOARD = parseBoard('0');

// Helper to get stone at row, col (0-5)
export function getStone(board, row, col) {
  return board.grid[row * 6 + col];
}
