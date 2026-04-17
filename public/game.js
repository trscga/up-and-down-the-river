// ─── Up and Down the River — Client ──────────────────────────────────────────

// ─── WebSocket Connection ───────────────────────────────────────────────────

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${location.host}/ws`);

let myId = null;
let gameState = null;
let trickPause = false;
let reqCounter = 0;
const pendingCallbacks = {};

ws.addEventListener('open', () => console.log('Connected to server'));
ws.addEventListener('close', () => console.log('Disconnected from server'));

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'yourId') {
    myId = msg.data.id;
  } else if (msg.type === 'reply') {
    const cb = pendingCallbacks[msg.reqId];
    if (cb) {
      delete pendingCallbacks[msg.reqId];
      cb(msg);
    }
  } else if (msg.type === 'gameState') {
    onGameState(msg.data);
  } else if (msg.type === 'trickComplete') {
    onTrickComplete(msg.data);
  }
});

function emit(action, payload, callback) {
  const reqId = ++reqCounter;
  if (callback) pendingCallbacks[reqId] = callback;
  ws.send(JSON.stringify({ action, payload, reqId }));
}

// ─── DOM References ──────────────────────────────────────────────────────────
const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  roundEnd: document.getElementById('screen-round-end'),
  gameOver: document.getElementById('screen-game-over'),
};

const dom = {
  inputName: document.getElementById('input-name'),
  inputCode: document.getElementById('input-code'),
  btnCreate: document.getElementById('btn-create'),
  btnJoin: document.getElementById('btn-join'),
  lobbyError: document.getElementById('lobby-error'),
  roomCodeDisplay: document.getElementById('room-code-display'),
  playerList: document.getElementById('player-list'),
  btnStart: document.getElementById('btn-start'),
  waitingMsg: document.getElementById('waiting-msg'),
  roundLabel: document.getElementById('round-label'),
  trumpDisplay: document.getElementById('trump-display'),
  btnScoreboard: document.getElementById('btn-scoreboard'),
  otherPlayers: document.getElementById('other-players'),
  trickCards: document.getElementById('trick-cards'),
  trickMessage: document.getElementById('trick-message'),
  bidArea: document.getElementById('bid-area'),
  bidButtons: document.getElementById('bid-buttons'),
  bidRestriction: document.getElementById('bid-restriction'),
  myName: document.getElementById('my-name'),
  myBidDisplay: document.getElementById('my-bid-display'),
  myTricksDisplay: document.getElementById('my-tricks-display'),
  myHand: document.getElementById('my-hand'),
  roundEndTitle: document.getElementById('round-end-title'),
  roundEndTable: document.getElementById('round-end-table'),
  btnNextRound: document.getElementById('btn-next-round'),
  roundEndWait: document.getElementById('round-end-wait'),
  winnerDisplay: document.getElementById('winner-display'),
  finalScoreTable: document.getElementById('final-score-table'),
  btnFullScoreboard: document.getElementById('btn-full-scoreboard'),
  btnPlayAgain: document.getElementById('btn-play-again'),
  scoreboardModal: document.getElementById('scoreboard-modal'),
  btnCloseScoreboard: document.getElementById('btn-close-scoreboard'),
  scoreboardBody: document.getElementById('scoreboard-body'),
};

const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

// ─── Screen Management ──────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─── Card Rendering ─────────────────────────────────────────────────────────

function createCardElement(card, mini = false) {
  const el = document.createElement('div');
  el.className = `card ${card.suit}${mini ? ' card-mini' : ''}`;
  el.innerHTML = `
    <span class="card-rank">${escHtml(card.rank)}</span>
    <span class="card-suit">${SUIT_SYMBOLS[card.suit]}</span>
  `;
  el.dataset.rank = card.rank;
  el.dataset.suit = card.suit;
  return el;
}

// ─── Lobby Events ───────────────────────────────────────────────────────────

dom.btnCreate.addEventListener('click', () => {
  const name = dom.inputName.value.trim();
  if (!name) { dom.lobbyError.textContent = 'Enter your name'; return; }
  dom.lobbyError.textContent = '';
  emit('createRoom', { name }, (res) => {
    if (res.ok) {
      showScreen('waiting');
    } else {
      dom.lobbyError.textContent = res.msg;
    }
  });
});

dom.btnJoin.addEventListener('click', () => {
  const name = dom.inputName.value.trim();
  const code = dom.inputCode.value.trim();
  if (!name) { dom.lobbyError.textContent = 'Enter your name'; return; }
  if (!code) { dom.lobbyError.textContent = 'Enter room code'; return; }
  dom.lobbyError.textContent = '';
  emit('joinRoom', { name, code }, (res) => {
    if (res.ok) {
      showScreen('waiting');
    } else {
      dom.lobbyError.textContent = res.msg;
    }
  });
});

dom.inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.btnCreate.click();
});
dom.inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.btnJoin.click();
});

// ─── Waiting Room ───────────────────────────────────────────────────────────

dom.btnStart.addEventListener('click', () => {
  emit('startGame', {}, (res) => {
    if (!res.ok) alert(res.msg);
  });
});

function renderWaitingRoom(state) {
  dom.roomCodeDisplay.textContent = state.roomCode;
  dom.playerList.innerHTML = '';

  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <span>${escHtml(p.name)}</span>
      ${i === 0 ? '<span class="host-badge">HOST</span>' : ''}
    `;
    dom.playerList.appendChild(div);
  });

  const isHost = state.players.length > 0 && state.players[0].id === myId;
  dom.btnStart.style.display = isHost && state.players.length >= 2 ? '' : 'none';
  dom.waitingMsg.style.display = isHost ? 'none' : '';
}

// ─── Game Rendering ─────────────────────────────────────────────────────────

function renderGame(state) {
  let roundTypeLabel = '';
  if (state.roundType === 'no-trump') roundTypeLabel = ' · NO TRUMP';
  else if (state.roundType === 'delayed-trump') roundTypeLabel = ' · DELAYED TRUMP';
  dom.roundLabel.textContent = `Round ${state.roundNumber}/${state.totalRounds} · ${state.cardsThisRound} card${state.cardsThisRound !== 1 ? 's' : ''}${roundTypeLabel}`;

  if (state.trumpHidden) {
    dom.trumpDisplay.innerHTML = `
      <div class="trump-label">Trump</div>
      <div class="trump-hidden">?<br>Revealed<br>after bids</div>
    `;
  } else if (state.trumpCard) {
    dom.trumpDisplay.innerHTML = `
      <div class="trump-label">Trump</div>
      <div class="trump-card-large ${state.trumpSuit}">
        <span class="card-rank">${escHtml(state.trumpCard.rank)}</span>
        <span class="card-suit">${SUIT_SYMBOLS[state.trumpSuit]}</span>
      </div>
    `;
  } else {
    dom.trumpDisplay.innerHTML = `
      <div class="trump-label">Trump</div>
      <div class="trump-none">No<br>Trump</div>
    `;
  }

  renderOtherPlayers(state);
  if (!trickPause) renderTrickArea(state);
  renderBidArea(state);
  renderMyHand(state);

  const me = state.players.find(p => p.id === myId);
  if (me) {
    dom.myName.textContent = me.name;
    dom.myBidDisplay.textContent = me.bid !== null && me.bid !== undefined ? `Bid: ${me.bid}` : '';
    dom.myTricksDisplay.textContent = state.state === 'playing' ? `Tricks: ${me.tricksWon}` : '';
  }
}

function renderOtherPlayers(state) {
  dom.otherPlayers.innerHTML = '';
  const others = state.players.filter(p => p.id !== myId);

  others.forEach(p => {
    const div = document.createElement('div');
    const isTurn = state.currentTurnId === p.id;
    const playerIdx = state.players.findIndex(pl => pl.id === p.id);
    const isDealer = playerIdx === state.dealerIndex;

    div.className = `opponent-card${isTurn ? ' is-turn' : ''}${isDealer ? ' is-dealer' : ''}${!p.connected ? ' disconnected' : ''}`;
    div.innerHTML = `
      <div class="opponent-name">${escHtml(p.name)}</div>
      <div class="opponent-details">
        <span>🃏${p.cardCount}</span>
        ${p.bid !== null && p.bid !== undefined ? `<span>Bid:${p.bid}</span>` : ''}
        ${state.state === 'playing' ? `<span>Won:${p.tricksWon}</span>` : ''}
      </div>
      <div class="opponent-details">
        <span>Score: ${p.score}</span>
      </div>
    `;
    dom.otherPlayers.appendChild(div);
  });
}

function renderTrickArea(state) {
  dom.trickCards.innerHTML = '';
  state.currentTrick.forEach(play => {
    const wrapper = document.createElement('div');
    wrapper.className = 'trick-card-wrapper';

    const label = document.createElement('div');
    label.className = 'trick-card-label';
    const player = state.players.find(p => p.id === play.playerId);
    label.textContent = player ? player.name : '?';

    const card = createCardElement(play.card, true);
    wrapper.appendChild(label);
    wrapper.appendChild(card);
    dom.trickCards.appendChild(wrapper);
  });

  if (state.state === 'playing' && !trickPause) {
    if (state.currentTurnId === myId) {
      dom.trickMessage.textContent = 'Your turn — play a card!';
    } else {
      const turnPlayer = state.players.find(p => p.id === state.currentTurnId);
      dom.trickMessage.textContent = turnPlayer ? `Waiting for ${turnPlayer.name}...` : '';
    }
  } else if (state.state === 'bidding') {
    if (state.currentTurnId === myId) {
      dom.trickMessage.textContent = 'Place your bid!';
    } else {
      const turnPlayer = state.players.find(p => p.id === state.currentTurnId);
      dom.trickMessage.textContent = turnPlayer ? `${turnPlayer.name} is bidding...` : '';
    }
  }
}

function renderBidArea(state) {
  if (state.state !== 'bidding' || state.currentTurnId !== myId) {
    dom.bidArea.style.display = 'none';
    return;
  }

  dom.bidArea.style.display = '';
  dom.bidButtons.innerHTML = '';
  dom.bidRestriction.textContent = '';

  for (let i = 0; i <= state.cardsThisRound; i++) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = i;
    btn.addEventListener('click', () => placeBid(i));
    dom.bidButtons.appendChild(btn);
  }
}

function renderMyHand(state) {
  dom.myHand.innerHTML = '';
  const isMyTurn = state.state === 'playing' && state.currentTurnId === myId;
  const ledSuit = state.currentTrick.length > 0 ? state.currentTrick[0].card.suit : null;
  const hasSuit = ledSuit ? state.myHand.some(c => c.suit === ledSuit) : false;

  state.myHand.forEach(card => {
    const el = createCardElement(card);
    if (isMyTurn) {
      const canPlay = !ledSuit || card.suit === ledSuit || !hasSuit;
      if (canPlay) {
        el.classList.add('playable');
        el.addEventListener('click', () => playCard(card));
      }
    }
    dom.myHand.appendChild(el);
  });
}

// ─── Actions ────────────────────────────────────────────────────────────────

function placeBid(bid) {
  emit('placeBid', { bid }, (res) => {
    if (!res.ok) alert(res.msg);
  });
}

function playCard(card) {
  emit('playCard', { card: { rank: card.rank, suit: card.suit } }, (res) => {
    if (!res.ok) alert(res.msg);
  });
}

// ─── Round End ──────────────────────────────────────────────────────────────

function renderRoundEnd(state) {
  const lastRound = state.roundScores[state.roundScores.length - 1];
  if (!lastRound) return;

  dom.roundEndTitle.textContent = `Round ${lastRound.round} Results (${lastRound.cardsThisRound} card${lastRound.cardsThisRound !== 1 ? 's' : ''})`;

  const tbody = dom.roundEndTable.querySelector('tbody');
  tbody.innerHTML = '';

  state.players.forEach(p => {
    const ps = lastRound.playerScores[p.id];
    if (!ps) return;
    const tr = document.createElement('tr');
    tr.className = ps.bid === ps.tricks ? 'made-bid' : 'missed-bid';
    tr.innerHTML = `
      <td>${escHtml(p.name)}</td>
      <td>${ps.bid}</td>
      <td>${ps.tricks}</td>
      <td>${ps.points > 0 ? '+' + ps.points : '0'}</td>
      <td>${ps.total}</td>
    `;
    tbody.appendChild(tr);
  });

  // Full cumulative scoreboard
  const sbDiv = document.getElementById('round-end-scoreboard');
  sbDiv.innerHTML = buildCumulativeScoreboard(state);

  const isHost = state.players[0]?.id === myId;
  dom.btnNextRound.style.display = isHost ? '' : 'none';
  dom.roundEndWait.style.display = isHost ? 'none' : '';
}

function buildCumulativeScoreboard(state) {
  const players = state.players;
  const rounds = state.roundScores;

  let html = '<table class="scoreboard-full"><thead><tr><th>Round</th><th>Cards</th>';
  players.forEach(p => { html += `<th>${escHtml(p.name)}</th>`; });
  html += '</tr></thead><tbody>';

  rounds.forEach(r => {
    html += `<tr><td>${r.round}</td><td>${r.cardsThisRound}</td>`;
    players.forEach(p => {
      const ps = r.playerScores[p.id];
      if (ps) {
        const cls = ps.bid === ps.tricks ? 'made' : 'missed';
        html += `<td class="${cls}">${ps.points > 0 ? '+' + ps.points : '0'}</td>`;
      } else {
        html += '<td>—</td>';
      }
    });
    html += '</tr>';
  });

  // Total row
  html += '<tr style="font-weight:700;border-top:2px solid var(--text-dim);"><td colspan="2">Total</td>';
  players.forEach(p => {
    html += `<td>${state.scores[p.id] || 0}</td>`;
  });
  html += '</tr>';

  html += '</tbody></table>';
  return html;
}

dom.btnNextRound.addEventListener('click', () => {
  emit('nextRound', {}, (res) => {
    if (!res.ok) alert(res.msg);
  });
});

// ─── Game Over ──────────────────────────────────────────────────────────────

function renderGameOver(state) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  dom.winnerDisplay.textContent = `${sorted[0].name} wins with ${sorted[0].score} points!`;

  const tbody = dom.finalScoreTable.querySelector('tbody');
  tbody.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  sorted.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${medals[i] || (i + 1)}</td>
      <td>${escHtml(p.name)}</td>
      <td>${p.score}</td>
    `;
    tbody.appendChild(tr);
  });

  const isHost = state.players[0]?.id === myId;
  dom.btnPlayAgain.style.display = isHost ? '' : 'none';
}

dom.btnPlayAgain.addEventListener('click', () => {
  emit('playAgain', {}, (res) => {
    if (!res.ok) alert(res.msg);
  });
});

// ─── Scoreboard Modal ───────────────────────────────────────────────────────

function openScoreboard() {
  if (!gameState || gameState.roundScores.length === 0) return;
  dom.scoreboardModal.style.display = 'flex';
  renderFullScoreboard();
}

function renderFullScoreboard() {
  const rounds = gameState.roundScores;
  const players = gameState.players;

  let html = '<table class="scoreboard-full"><thead><tr><th>Round</th><th>Cards</th>';
  players.forEach(p => { html += `<th>${escHtml(p.name)}</th>`; });
  html += '</tr></thead><tbody>';

  rounds.forEach(r => {
    html += `<tr><td>${r.round}</td><td>${r.cardsThisRound}</td>`;
    players.forEach(p => {
      const ps = r.playerScores[p.id];
      if (ps) {
        const cls = ps.bid === ps.tricks ? 'made' : 'missed';
        html += `<td class="${cls}">${ps.bid}/${ps.tricks} (+${ps.points}) = ${ps.total}</td>`;
      } else {
        html += '<td>—</td>';
      }
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  dom.scoreboardBody.innerHTML = html;
}

dom.btnScoreboard.addEventListener('click', openScoreboard);
dom.btnFullScoreboard.addEventListener('click', openScoreboard);
dom.btnCloseScoreboard.addEventListener('click', () => {
  dom.scoreboardModal.style.display = 'none';
});
dom.scoreboardModal.addEventListener('click', (e) => {
  if (e.target === dom.scoreboardModal) dom.scoreboardModal.style.display = 'none';
});

// ─── Socket Events ──────────────────────────────────────────────────────────

function onGameState(state) {
  gameState = state;

  switch (state.state) {
    case 'lobby':
      showScreen('waiting');
      renderWaitingRoom(state);
      break;
    case 'bidding':
    case 'playing':
      showScreen('game');
      if (!trickPause) renderGame(state);
      break;
    case 'roundEnd':
      showScreen('roundEnd');
      renderRoundEnd(state);
      break;
    case 'gameOver':
      showScreen('gameOver');
      renderGameOver(state);
      break;
  }
}

function onTrickComplete(data) {
  trickPause = true;

  dom.trickCards.innerHTML = '';
  data.trick.forEach(play => {
    const wrapper = document.createElement('div');
    wrapper.className = 'trick-card-wrapper';

    const label = document.createElement('div');
    label.className = 'trick-card-label';
    const player = gameState?.players.find(p => p.id === play.playerId);
    label.textContent = player ? player.name : '?';

    const card = createCardElement(play.card, true);
    if (play.playerId === data.winner) {
      card.style.borderColor = 'var(--gold)';
      card.style.boxShadow = '0 0 12px rgba(245,197,24,0.6)';
    }

    wrapper.appendChild(label);
    wrapper.appendChild(card);
    dom.trickCards.appendChild(wrapper);
  });

  dom.trickMessage.textContent = `${data.winnerName} wins the trick!`;

  setTimeout(() => {
    trickPause = false;
    if (gameState) {
      if (gameState.state === 'roundEnd') {
        showScreen('roundEnd');
        renderRoundEnd(gameState);
      } else if (gameState.state === 'gameOver') {
        showScreen('gameOver');
        renderGameOver(gameState);
      } else {
        renderGame(gameState);
      }
    }
  }, 2400);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
