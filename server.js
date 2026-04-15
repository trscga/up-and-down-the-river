const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ──────────────────────────────────────────────────────────────

const rooms = new Map(); // roomCode -> GameRoom

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank] });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function cardId(card) {
  return `${card.rank}_${card.suit}`;
}

// ─── Game Room ───────────────────────────────────────────────────────────────

class GameRoom {
  constructor(code, hostId, hostName) {
    this.code = code;
    this.players = [{ id: hostId, name: hostName, connected: true }];
    this.state = 'lobby'; // lobby | bidding | playing | roundEnd | gameOver
    this.scores = {};
    this.dealerIndex = 0;
    this.roundNumber = 0;
    this.cardsThisRound = 0;
    this.roundSequence = [];
    this.trumpCard = null;
    this.trumpSuit = null;
    this.hands = {};       // playerId -> [card]
    this.bids = {};        // playerId -> number
    this.tricks = {};      // playerId -> number (tricks won this round)
    this.currentTrick = []; // [{ playerId, card }]
    this.turnIndex = 0;
    this.leadIndex = 0;
    this.roundScores = []; // history: [{ round, cardsThisRound, playerScores: { id: {bid, tricks, points} } }]
  }

  addPlayer(id, name) {
    if (this.players.length >= 6) return false;
    if (this.state !== 'lobby') return false;
    if (this.players.find(p => p.id === id)) return false;
    this.players.push({ id, name, connected: true });
    this.scores[id] = 0;
    return true;
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
    delete this.scores[id];
    delete this.hands[id];
    delete this.bids[id];
    delete this.tricks[id];
  }

  getPlayerOrder() {
    return this.players.map(p => p.id);
  }

  buildRoundSequence() {
    const numPlayers = this.players.length;
    const maxCards = Math.floor(51 / numPlayers);
    const seq = [];
    for (let i = 1; i <= maxCards; i++) seq.push(i);
    for (let i = maxCards - 1; i >= 1; i--) seq.push(i);
    this.roundSequence = seq;
  }

  startGame() {
    if (this.players.length < 2) return false;
    this.state = 'bidding';
    this.players.forEach(p => { this.scores[p.id] = 0; });
    this.dealerIndex = 0;
    this.roundNumber = 0;
    this.roundScores = [];
    this.buildRoundSequence();
    this.startRound();
    return true;
  }

  startRound() {
    this.cardsThisRound = this.roundSequence[this.roundNumber];
    this.bids = {};
    this.tricks = {};
    this.currentTrick = [];
    this.players.forEach(p => { this.tricks[p.id] = 0; });

    // Deal cards
    const deck = shuffleDeck(createDeck());
    const numPlayers = this.players.length;
    this.hands = {};
    for (let i = 0; i < numPlayers; i++) {
      const pid = this.players[i].id;
      this.hands[pid] = deck.splice(0, this.cardsThisRound);
      // Sort hand by suit then rank
      this.hands[pid].sort((a, b) => {
        const suitOrder = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
        if (suitOrder !== 0) return suitOrder;
        return a.value - b.value;
      });
    }

    // Trump card
    if (deck.length > 0) {
      this.trumpCard = deck[0];
      this.trumpSuit = this.trumpCard.suit;
    } else {
      this.trumpCard = null;
      this.trumpSuit = null;
    }

    // First bidder is left of dealer
    this.turnIndex = (this.dealerIndex + 1) % numPlayers;
    this.leadIndex = this.turnIndex;
    this.state = 'bidding';
  }

  getCurrentPlayerId() {
    return this.players[this.turnIndex].id;
  }

  placeBid(playerId, bid) {
    if (this.state !== 'bidding') return { ok: false, msg: 'Not in bidding phase' };
    if (this.getCurrentPlayerId() !== playerId) return { ok: false, msg: 'Not your turn to bid' };
    if (bid < 0 || bid > this.cardsThisRound) return { ok: false, msg: 'Invalid bid' };

    this.bids[playerId] = bid;

    // Check if all bids are in
    if (Object.keys(this.bids).length === numPlayers) {
      this.state = 'playing';
      this.turnIndex = this.leadIndex;
    } else {
      this.turnIndex = (this.turnIndex + 1) % numPlayers;
    }

    return { ok: true };
  }

  playCard(playerId, card) {
    if (this.state !== 'playing') return { ok: false, msg: 'Not in playing phase' };
    if (this.getCurrentPlayerId() !== playerId) return { ok: false, msg: 'Not your turn' };

    const hand = this.hands[playerId];
    const cardIndex = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
    if (cardIndex === -1) return { ok: false, msg: 'Card not in your hand' };

    // Must follow suit if possible
    if (this.currentTrick.length > 0) {
      const ledSuit = this.currentTrick[0].card.suit;
      const hasSuit = hand.some(c => c.suit === ledSuit);
      if (hasSuit && card.suit !== ledSuit) {
        return { ok: false, msg: `You must follow suit (${ledSuit})` };
      }
    }

    // Remove card from hand
    hand.splice(cardIndex, 1);
    this.currentTrick.push({ playerId, card });

    const numPlayers = this.players.length;

    if (this.currentTrick.length === numPlayers) {
      // Trick complete — determine winner
      const winner = this.determineTrickWinner();
      this.tricks[winner]++;

      const completedTrick = [...this.currentTrick];
      this.currentTrick = [];

      // Check if round is over
      if (hand.length === 0 && Object.values(this.hands).every(h => h.length === 0)) {
        // Round over
        this.scoreRound();

        if (this.roundNumber >= this.roundSequence.length - 1) {
          this.state = 'gameOver';
        } else {
          this.state = 'roundEnd';
        }

        return { ok: true, trickComplete: true, trickWinner: winner, completedTrick, roundOver: true };
      }

      // Next trick: winner leads
      const winnerIdx = this.players.findIndex(p => p.id === winner);
      this.turnIndex = winnerIdx;
      this.leadIndex = winnerIdx;

      return { ok: true, trickComplete: true, trickWinner: winner, completedTrick };
    } else {
      this.turnIndex = (this.turnIndex + 1) % numPlayers;
      return { ok: true, trickComplete: false };
    }
  }

  determineTrickWinner() {
    const ledSuit = this.currentTrick[0].card.suit;
    let bestPlay = this.currentTrick[0];

    for (let i = 1; i < this.currentTrick.length; i++) {
      const play = this.currentTrick[i];
      const bestIsTrump = bestPlay.card.suit === this.trumpSuit;
      const currIsTrump = play.card.suit === this.trumpSuit;

      if (currIsTrump && !bestIsTrump) {
        bestPlay = play;
      } else if (currIsTrump && bestIsTrump) {
        if (play.card.value > bestPlay.card.value) bestPlay = play;
      } else if (!currIsTrump && !bestIsTrump) {
        if (play.card.suit === ledSuit && bestPlay.card.suit === ledSuit) {
          if (play.card.value > bestPlay.card.value) bestPlay = play;
        } else if (play.card.suit === ledSuit) {
          bestPlay = play;
        }
      }
    }
    return bestPlay.playerId;
  }

  scoreRound() {
    const roundData = {
      round: this.roundNumber + 1,
      cardsThisRound: this.cardsThisRound,
      playerScores: {}
    };

    for (const p of this.players) {
      const bid = this.bids[p.id];
      const tricks = this.tricks[p.id];
      let points = 0;
      if (bid === tricks) {
        points = 10 + tricks;
      }
      this.scores[p.id] += points;
      roundData.playerScores[p.id] = { bid, tricks, points, total: this.scores[p.id] };
    }

    this.roundScores.push(roundData);
  }

  nextRound() {
    this.roundNumber++;
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    this.startRound();
  }

  getPublicState(forPlayerId) {
    const playerList = this.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: this.scores[p.id] || 0,
      bid: this.bids[p.id] !== undefined ? this.bids[p.id] : null,
      tricksWon: this.tricks[p.id] || 0,
      cardCount: this.hands[p.id] ? this.hands[p.id].length : 0
    }));

    return {
      roomCode: this.code,
      state: this.state,
      players: playerList,
      dealerIndex: this.dealerIndex,
      roundNumber: this.roundNumber + 1,
      totalRounds: this.roundSequence.length,
      cardsThisRound: this.cardsThisRound,
      trumpCard: this.trumpCard,
      trumpSuit: this.trumpSuit,
      currentTrick: this.currentTrick.map(t => ({ playerId: t.playerId, card: t.card })),
      currentTurnId: this.state === 'lobby' || this.state === 'gameOver' ? null : this.getCurrentPlayerId(),
      myHand: this.hands[forPlayerId] || [],
      roundScores: this.roundScores,
      scores: { ...this.scores }
    };
  }
}

// ─── Socket.io ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);
  let currentRoom = null;
  let playerName = null;

  socket.on('createRoom', ({ name }, callback) => {
    if (!name || name.trim().length === 0) {
      return callback({ ok: false, msg: 'Name is required' });
    }
    const code = generateRoomCode();
    playerName = name.trim().substring(0, 20);
    const room = new GameRoom(code, socket.id, playerName);
    room.scores[socket.id] = 0;
    rooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    callback({ ok: true, roomCode: code });
    emitState(room);
  });

  socket.on('joinRoom', ({ code, name }, callback) => {
    if (!name || name.trim().length === 0) {
      return callback({ ok: false, msg: 'Name is required' });
    }
    if (!code || code.trim().length === 0) {
      return callback({ ok: false, msg: 'Room code is required' });
    }
    const roomCode = code.trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ ok: false, msg: 'Room not found' });

    playerName = name.trim().substring(0, 20);

    // Check for duplicate name
    if (room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return callback({ ok: false, msg: 'That name is already taken in this room' });
    }

    if (!room.addPlayer(socket.id, playerName)) {
      return callback({ ok: false, msg: 'Cannot join room (full or game already started)' });
    }

    currentRoom = roomCode;
    socket.join(roomCode);
    callback({ ok: true, roomCode });
    emitState(room);
  });

  socket.on('startGame', (_, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) return callback({ ok: false, msg: 'Room not found' });
    if (room.players[0].id !== socket.id) return callback({ ok: false, msg: 'Only the host can start the game' });
    if (!room.startGame()) return callback({ ok: false, msg: 'Need at least 2 players' });
    callback({ ok: true });
    emitState(room);
  });

  socket.on('placeBid', ({ bid }, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) return callback({ ok: false, msg: 'Room not found' });
    const result = room.placeBid(socket.id, bid);
    callback(result);
    if (result.ok) emitState(room);
  });

  socket.on('playCard', ({ card }, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) return callback({ ok: false, msg: 'Room not found' });
    const result = room.playCard(socket.id, card);
    callback(result);
    if (result.ok) {
      if (result.trickComplete) {
        // Send trick result with a slight delay so everyone can see the last card
        const trickResult = {
          winner: result.trickWinner,
          winnerName: room.players.find(p => p.id === result.trickWinner)?.name,
          trick: result.completedTrick,
          roundOver: result.roundOver || false
        };
        io.to(currentRoom).emit('trickComplete', trickResult);
        // After a delay, send updated state
        setTimeout(() => {
          emitState(room);
        }, 2500);
      } else {
        emitState(room);
      }
    }
  });

  socket.on('nextRound', (_, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) return callback({ ok: false, msg: 'Room not found' });
    if (room.players[0].id !== socket.id) return callback({ ok: false, msg: 'Only the host can advance' });
    room.nextRound();
    callback({ ok: true });
    emitState(room);
  });

  socket.on('playAgain', (_, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) return callback({ ok: false, msg: 'Room not found' });
    if (room.players[0].id !== socket.id) return callback({ ok: false, msg: 'Only the host can restart' });
    room.dealerIndex = 0;
    room.roundNumber = 0;
    room.roundScores = [];
    room.startGame();
    callback({ ok: true });
    emitState(room);
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.connected = false;

        // If all disconnected, remove room after delay
        if (room.players.every(p => !p.connected)) {
          setTimeout(() => {
            const r = rooms.get(currentRoom);
            if (r && r.players.every(p => !p.connected)) {
              rooms.delete(currentRoom);
              console.log(`Room ${currentRoom} removed (all disconnected)`);
            }
          }, 60000);
        } else {
          emitState(room);
        }
      }
    }
  });
});

function emitState(room) {
  for (const player of room.players) {
    const state = room.getPublicState(player.id);
    io.to(player.id).emit('gameState', state);
  }
}

// ─── Cleanup stale rooms periodically ────────────────────────────────────────
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.every(p => !p.connected)) {
      rooms.delete(code);
      console.log(`Cleaned up stale room: ${code}`);
    }
  }
}, 300000); // Every 5 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Up and Down the River running on http://localhost:${PORT}`);
});
