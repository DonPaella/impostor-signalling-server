const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const path = require('path');
const app = express();

// Serve static client files from /public
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let rooms = {};

app.get("/", (req, res) => {
  // serve the game UI
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Full multiplayer game implementation over WebSocket
// room structure: { hostId, players: [{id, name, ws, score, role}], phase, totalRounds, round, secretWord, hints: [], endVoteSet: Set, votes: {}, voteTimer }
const FOOD_DECK = [
  'Pizza','Sushi','Burger','Taco','Pasta','Ice Cream','Salad','Steak','Ramen','Curry','Dumplings','Pancake','Chocolate','Banana','Apple','Orange','Sandwich','Fries','Kebab','Paella'
];

function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { console.warn('send failed', e); } }

function broadcastToRoom(roomCode, obj) {
  const room = rooms[roomCode];
  if (!room) return;
  room.players.forEach(p => { if (p.ws && p.ws.readyState === WebSocket.OPEN) send(p.ws, obj); });
}

function updatePlayerList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const list = room.players.map(p => ({ id: p.id, name: p.name, score: p.score }));
  broadcastToRoom(roomCode, { type: 'player-list', players: list, hostId: room.hostId });
}

function chooseSecret() { return FOOD_DECK[Math.floor(Math.random() * FOOD_DECK.length)]; }

wss.on('connection', (ws, req) => {
  ws.id = makeId();

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return send(ws, { type: 'error', error: 'invalid-json' }); }
    const { type, room: roomCode, payload } = data;

    // create-room: { type: 'create-room', room?, payload:{name} }
    if (type === 'create-room') {
      const room = roomCode || (''+Math.floor(10000000 + Math.random() * 90000000));
      if (!rooms[room]) {
        rooms[room] = { hostId: ws.id, players: [], phase: 'lobby', totalRounds: 3, round: 0, secretWord: null, hints: [], endVoteSet: new Set(), votes: {}, voteTimer: null };
      }
      const r = rooms[room];
      const name = payload && payload.name ? payload.name : 'Host';
      r.players.push({ id: ws.id, name, ws, score: 0 });
      ws.room = room; ws.isHost = true; r.hostId = ws.id;
      updatePlayerList(room);
      send(ws, { type: 'room-created', room });
      // notify the creator of their id/room
      send(ws, { type: 'joined', id: ws.id, room });
      return;
    }

    if (type === 'join-room') {
      const room = rooms[roomCode];
      if (!room) return send(ws, { type: 'error', error: 'no-such-room' });
      const name = payload && payload.name ? payload.name : 'Player';
      if (room.players.find(p => p.name === name)) return send(ws, { type: 'error', error: 'name-taken' });
  room.players.push({ id: ws.id, name, ws, score: 0 });
  ws.room = roomCode; ws.isHost = (ws.id === room.hostId);
  // acknowledge to joining client
  send(ws, { type: 'joined', id: ws.id, room: roomCode });
  updatePlayerList(roomCode);
  broadcastToRoom(roomCode, { type: 'player-joined', player: { id: ws.id, name } });
      return;
    }

    // further actions require a room
    const room = rooms[roomCode];
    if (!room) return send(ws, { type: 'error', error: 'not-in-room' });

    if (type === 'start-game') {
      if (ws.id !== room.hostId) return send(ws, { type: 'error', error: 'not-host' });
      const rounds = (payload && payload.rounds) ? parseInt(payload.rounds) : 3;
      // initialize round and turn state
      room.totalRounds = rounds;
      room.round = 1;
      room.phase = 'playing';
      room.hints = [];
      room.endVoteSet = new Set();
      room.votes = {};
      room.order = room.players.map(p => p.id).sort(() => Math.random() - 0.5);
      room.turnIndex = 0; // index into order
      room.hintPass = 1; // pass 1 or 2
      room.secretWord = chooseSecret();
      const impIndex = Math.floor(Math.random() * room.players.length);
      room.players.forEach((p, idx) => { p.role = (idx === impIndex) ? 'IMPOSTOR' : 'FAITHFUL'; });
      // send roles individually
      room.players.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
          if (p.role === 'FAITHFUL') send(p.ws, { type: 'role', role: p.role, secret: room.secretWord });
          else send(p.ws, { type: 'role', role: p.role });
        }
      });
      broadcastToRoom(roomCode, { type: 'game-started', round: room.round, totalRounds: room.totalRounds, order: room.order });
      // start first player's turn
      startTurn(roomCode);
      return;
    }

    if (type === 'submit-hint') {
      if (room.phase !== 'playing') return;
      const player = room.players.find(p => p.id === ws.id); if (!player) return;
      // enforce turn-based submission
      if (!room.order || room.order[room.turnIndex] !== ws.id) return send(ws, { type: 'error', error: 'not-your-turn' });
      const text = payload && payload.text ? String(payload.text).trim() : '';
      // cancel timers for this turn
      if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
      if (room.turnGraceTimer) { clearTimeout(room.turnGraceTimer); room.turnGraceTimer = null; }
      if (text) { room.hints.push({ from: player.name, text }); broadcastToRoom(roomCode, { type: 'hint', from: player.name, text }); }
      // advance the turn
      advanceTurn(roomCode);
      return;
    }

    if (type === 'request-end-vote') {
      room.endVoteSet.add(ws.id);
      broadcastToRoom(roomCode, { type: 'end-vote-status', count: room.endVoteSet.size, needed: Math.floor(room.players.length/2)+1 });
      if (room.endVoteSet.size >= Math.floor(room.players.length/2)+1) {
        room.phase = 'voting'; room.votes = {};
        broadcastToRoom(roomCode, { type: 'start-vote', timeout: 20 });
        if (room.voteTimer) clearTimeout(room.voteTimer);
        room.voteTimer = setTimeout(() => { resolveVotes(roomCode); }, 20000);
      }
      return;
    }

    if (type === 'cast-vote') {
      if (room.phase !== 'voting') return;
      const targetId = payload && payload.targetId; if (!targetId) return;
      room.votes[ws.id] = targetId;
      if (Object.keys(room.votes).length >= room.players.length) { if (room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; } resolveVotes(roomCode); }
      return;
    }

    if (type === 'traitor-guess') { const guess = payload && payload.guess ? String(payload.guess) : ''; handleTraitorGuess(roomCode, ws.id, guess); return; }
  });

  ws.on('close', () => {
    const roomCode = ws.room; if (!roomCode || !rooms[roomCode]) return; const room = rooms[roomCode]; room.players = room.players.filter(p => p.id !== ws.id);
    if (room.hostId === ws.id) { if (room.players.length > 0) room.hostId = room.players[0].id; else delete rooms[roomCode]; }
    updatePlayerList(roomCode);
  });

  ws.on('error', (err) => { console.error('WebSocket error:', err); });
});

function resolveVotes(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  const tally = {};
  Object.values(room.votes).forEach(tid => { tally[tid] = (tally[tid]||0)+1; });
  if (Object.keys(tally).length === 0) { const chosen = room.players[Math.floor(Math.random()*room.players.length)].id; finalizeVote(roomCode, chosen); return; }
  const max = Math.max(...Object.values(tally)); const top = Object.keys(tally).filter(id => tally[id] === max);
  if (top.length === 1) finalizeVote(roomCode, top[0]);
  else {
    // tie: broadcast tie so clients can show spinner, then resolve after short delay
    broadcastToRoom(roomCode, { type: 'vote-tie', top });
    setTimeout(() => {
      const chosen = top[Math.floor(Math.random()*top.length)];
      finalizeVote(roomCode, chosen);
    }, 2500);
  }
}

function finalizeVote(roomCode, chosenId) {
  const room = rooms[roomCode]; if (!room) return; const chosenPlayer = room.players.find(p => p.id === chosenId); const impostor = room.players.find(p => p.role === 'IMPOSTOR');
  broadcastToRoom(roomCode, { type: 'vote-result', chosenId, chosenName: chosenPlayer ? chosenPlayer.name : null, impostorId: impostor ? impostor.id : null });
  if (chosenId === (impostor && impostor.id)) {
    if (impostor && impostor.ws && impostor.ws.readyState === WebSocket.OPEN) {
      send(impostor.ws, { type: 'ask-traitor-guess', timeout: 20 });
      setTimeout(() => { revealRoundOutcome(roomCode, false, chosenId); }, 25000);
    } else { revealRoundOutcome(roomCode, false, chosenId); }
  } else { revealRoundOutcome(roomCode, true, chosenId); }
}

function handleTraitorGuess(roomCode, wsId, guess) {
  const room = rooms[roomCode]; if (!room) return; const impostor = room.players.find(p => p.role === 'IMPOSTOR'); if (!impostor || impostor.id !== wsId) return;
  const normalize = s => s.replace(/\s+/g,'').toLowerCase(); const correct = normalize(guess) === normalize(room.secretWord);
  revealRoundOutcome(roomCode, correct, impostor.id);
}

function revealRoundOutcome(roomCode, traitorGuessedCorrectly, chosenId) {
  const room = rooms[roomCode]; if (!room) return; const impostor = room.players.find(p => p.role === 'IMPOSTOR');
  if (chosenId === (impostor && impostor.id)) {
    if (traitorGuessedCorrectly) { impostor.score = (impostor.score||0) + 1; broadcastToRoom(roomCode, { type: 'round-end', result: 'traitor-guessed-correctly', secret: room.secretWord, scores: room.players.map(p=>({name:p.name,score:p.score})) }); }
    else { room.players.forEach(p => { if (p.role === 'FAITHFUL') p.score = (p.score||0) + 1; }); broadcastToRoom(roomCode, { type: 'round-end', result: 'faithfuls-win', secret: room.secretWord, scores: room.players.map(p=>({name:p.name,score:p.score})) }); }
  } else { if (impostor) impostor.score = (impostor.score||0) + 1; broadcastToRoom(roomCode, { type: 'round-end', result: 'impostor-survived', secret: room.secretWord, chosenId, scores: room.players.map(p=>({name:p.name,score:p.score})) }); }

  if (room.round >= room.totalRounds) { broadcastToRoom(roomCode, { type: 'game-end', leaderboard: room.players.map(p=>({name:p.name,score:p.score})) }); room.phase = 'ended'; }
  else {
    room.round += 1; room.phase = 'playing'; room.hints = []; room.endVoteSet = new Set(); room.votes = {}; room.secretWord = chooseSecret();
    const impIndex = Math.floor(Math.random() * room.players.length); room.players.forEach((p, idx) => { p.role = (idx === impIndex) ? 'IMPOSTOR' : 'FAITHFUL'; });
    room.players.forEach(p => { if (p.ws && p.ws.readyState === WebSocket.OPEN) { if (p.role === 'FAITHFUL') send(p.ws, { type: 'role', role: p.role, secret: room.secretWord }); else send(p.ws, { type: 'role', role: p.role }); } });
    const order = room.players.map(p => p.id).sort(() => Math.random() - 0.5); broadcastToRoom(roomCode, { type: 'game-started', round: room.round, totalRounds: room.totalRounds, order });
  }
}

// Turn management: start a player's turn, enforce timers, grace period and kicking
function startTurn(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  if (!room.order || room.order.length === 0) return;
  // ensure turnIndex in range
  if (room.turnIndex >= room.order.length) room.turnIndex = 0;
  const pid = room.order[room.turnIndex];
  // notify clients who has the turn and time (20s)
  broadcastToRoom(roomCode, { type: 'turn-start', playerId: pid, timeout: 20, hintPass: room.hintPass });
  // notify the player specifically
  const player = room.players.find(p => p.id === pid);
  if (player && player.ws && player.ws.readyState === WebSocket.OPEN) send(player.ws, { type: 'your-turn', timeout: 20 });
  // start 20s timer; if expires, give 10s grace, then kick
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    // notify grace
    broadcastToRoom(roomCode, { type: 'turn-grace', playerId: pid, grace: 10 });
    const p = room.players.find(p => p.id === pid);
    if (p && p.ws && p.ws.readyState === WebSocket.OPEN) send(p.ws, { type: 'turn-grace', grace: 10 });
    // start grace timer
    if (room.turnGraceTimer) clearTimeout(room.turnGraceTimer);
    room.turnGraceTimer = setTimeout(() => {
      // kick player
      kickPlayer(roomCode, pid, 'timeout');
      // after kicking, continue with same turnIndex (since players list changed)
      // if players remain, start next turn
      const r = rooms[roomCode]; if (r && r.players.length > 0) startTurn(roomCode);
    }, 10000);
  }, 20000);
}

function advanceTurn(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  // advance index
  room.turnIndex = (room.turnIndex + 1) % room.order.length;
  // if completed a full pass
  if (room.turnIndex === 0) {
    if (room.hintPass === 1) { room.hintPass = 2; }
    else {
      // completed both passes; allow request-vote phase
      broadcastToRoom(roomCode, { type: 'hints-complete' });
      return;
    }
  }
  // start next player's turn
  startTurn(roomCode);
}

function kickPlayer(roomCode, playerId, reason) {
  const room = rooms[roomCode]; if (!room) return;
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;
  const [removed] = room.players.splice(idx,1);
  // remove from order
  room.order = room.order.filter(id => id !== playerId);
  // adjust turnIndex if needed
  if (room.turnIndex >= room.order.length) room.turnIndex = 0;
  broadcastToRoom(roomCode, { type: 'player-kicked', id: playerId, name: removed.name, reason });
  updatePlayerList(roomCode);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});