// Smoke test for the socket.io flow, no real API key needed.
// Usage: node scripts/smoke.mjs

import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:8787';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log('[smoke]', ...a);

function emitAck(socket, evt, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(evt, payload ?? {}, (res) => {
      if (res && res.ok === false) reject(new Error(res.error || 'ack failed'));
      else resolve(res);
    });
  });
}

const socket = io(URL, { transports: ['websocket'] });

const events = [];
for (const evt of ['msg:start', 'msg:delta', 'msg:done', 'userMsg', 'topic', 'paused', 'state', 'error', 'speaking']) {
  socket.on(evt, (p) => events.push({ evt, p }));
}

socket.on('connect_error', (e) => {
  log('connect_error', e.message);
  process.exit(1);
});

async function main() {
  await new Promise((r) => socket.on('connect', r));

  log('creating room…');
  const created = await emitAck(socket, 'room:create', {
    apiKey: 'sk-fake-key',
    baseUrl: 'http://127.0.0.1:8787', // fake LLM endpoint -> forces an error event
    pacing: 'lively',
    personaIds: ['mia', 'jake', 'sofia'],
    topicIds: ['food', 'travel', 'movies'],
  });
  const roomId = created.roomId;
  log('room created', roomId);

  const listed = await emitAck(socket, 'room:list');
  log('rooms listed:', listed.rooms.length);

  log('joining room…');
  const joined = await emitAck(socket, 'room:join', { roomId, apiKey: 'sk-fake-key' });
  log('joined: personas =', joined.personas.map((p) => p.name).join(','), '| topic =', joined.state.topic, '| history =', joined.history.length);

  // the engine will try to talk using the fake key -> expect an error event
  await delay(4000);

  log('sending a user message…');
  await emitAck(socket, 'user:msg', { text: 'Hey everyone, how is it going?' });
  await delay(1500);

  log('pausing…');
  await emitAck(socket, 'room:pause', { paused: true });
  await delay(400);
  log('resuming…');
  await emitAck(socket, 'room:pause', { paused: false });

  await emitAck(socket, 'room:leave');
  await delay(300);

  const seen = events.map((e) => e.evt);
  log('events seen:', [...new Set(seen)].join(', '));
  const errors = events.filter((e) => e.evt === 'error');
  log('errors received:', errors.length, errors[0] ? JSON.stringify(errors[0].p).slice(0, 160) : '-');
  log('SMOKE OK');
  socket.close();
  process.exit(0);
}

main().catch((e) => {
  log('SMOKE FAILED', e.message);
  socket.close();
  process.exit(1);
});
