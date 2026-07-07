// game.js
// High level game controller for Pentago.
// Supports 1-player (human vs perfect AI) and 2-player local play.
// Handles placing, rotating, win/tie detection, and optional solver-driven AI replies.

import { START_BOARD, getStone } from './board.js';

export class PentagoGame {
  constructor() {
    this.reset();
  }

  reset(humanIsBlack = true, playerMode = 1) {
    this.board = START_BOARD;
    this.history = [START_BOARD.name];
    this.humanIsBlack = humanIsBlack; // true = human black (first), false = human white (second)
    this.playerMode = playerMode; // 1 = human vs AI, 2 = local two players
    this.gameOver = false;
    this.winner = null; // 1 black, 2 white, 0 tie
    this.message = this.playerMode === 2
      ? 'Black to move'
      : (humanIsBlack ? 'Your turn (Black)' : 'AI (Black) is thinking...');
    this.pendingPlace = null; // {r, c} when human has placed but not rotated yet
  }

  isHumanTurn() {
    if (this.gameOver) return false;
    if (this.playerMode === 2) return true;
    const currentIsBlack = !this.board.turn; // turn false = black
    const humanIsCurrent = (currentIsBlack && this.humanIsBlack) || (!currentIsBlack && !this.humanIsBlack);
    return humanIsCurrent;
  }

  // Human wants to place a stone at (row, col)
  // Returns true if the place was accepted (now in "rotate" phase)
  humanPlace(row, col) {
    if (!this.isHumanTurn() || this.board.middle || this.gameOver) return false;
    if (getStone(this.board, row, col) !== 0) return false;

    const afterPlace = this.board.place(row, col);

    if (afterPlace.done) {
      // Immediate win by placement, no rotate needed.
      // This is a completed move, so record it in history (like humanRotate/commitAiMove)
      // to keep undo consistent with the displayed board.
      this.board = afterPlace;
      this.history.push(this.board.name);
      this._finishTurn();
      return true;
    }

    this.pendingPlace = { row, col };
    this.board = afterPlace; // now middle=true
    this.message = 'Rotate a quadrant';
    return true;
  }

  // Human chooses a rotation to complete their turn
  humanRotate(qx, qy, dir) {
    if (!this.isHumanTurn() || !this.board.middle || this.gameOver || !this.pendingPlace) return false;

    const afterRot = this.board.rotate(qx, qy, dir);
    this.board = afterRot;
    this.pendingPlace = null;
    this.history.push(this.board.name);

    this._finishTurn();
    return true;
  }

  _finishTurn() {
    if (this.board.done) {
      this.gameOver = true;
      this._setWinnerMessage();
      return;
    }

    // Switch turn
    if (this.playerMode === 2) {
      this.message = this.board.currentPlayer === 1 ? 'Black to move' : 'White to move';
      return;
    }
    const humanToMoveNow = this.isHumanTurn();
    this.message = humanToMoveNow ? 'Your turn' : 'Perfect AI is thinking...';
  }

  _setWinnerMessage() {
    const bw = this.board.fives.some(f => this.board.grid[6 * f[0][0] + f[0][1]] === 1);
    const ww = this.board.fives.some(f => this.board.grid[6 * f[0][0] + f[0][1]] === 2);

    if (bw && ww) {
      this.winner = 0;
      this.message = 'Tie!';
      return;
    }
    if (!bw && !ww) {
      this.winner = 0;
      this.message = 'Board full — Tie!';
      return;
    }

    const blackWon = bw;
    if (this.playerMode === 2) {
      this.winner = blackWon ? 1 : 2;
      this.message = blackWon ? 'Black wins!' : 'White wins!';
      return;
    }
    const humanWon = (blackWon && this.humanIsBlack) || (!blackWon && !this.humanIsBlack);

    this.winner = blackWon ? 1 : 2;
    this.message = humanWon ? 'You win!' : 'AI wins!';
  }

  // Commit the AI's final board state into history and status.
  commitAiMove(finalBoard) {
    this.board = finalBoard;
    this.history.push(finalBoard.name);

    if (this.board.done) {
      this.gameOver = true;
      this._setWinnerMessage();
    } else {
      this.message = this.playerMode === 2
        ? (this.board.currentPlayer === 1 ? 'Black to move' : 'White to move')
        : 'Your turn';
    }
  }

  // Temporary board for UI animation (does not modify history).
  setTransientBoard(board, message = null) {
    this.board = board;
    if (message) this.message = message;
  }

  // For UI: get the current display board (the one after last complete action)
  getBoard() {
    return this.board;
  }

  getStatus() {
    return {
      message: this.message,
      gameOver: this.gameOver,
      winner: this.winner,
      count: this.board.count,
      isHumanTurn: this.isHumanTurn(),
      inRotatePhase: !!this.board.middle && this.pendingPlace !== null
    };
  }
}
