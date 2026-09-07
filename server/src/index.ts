import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import fastifyStatic from '@fastify/static';
import { registerSockets } from './sockets.js';
import { PERSONAS, TOPICS } from './personas.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const app = Fastify({ logger: false });

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/meta', async () => ({
  personas: PERSONAS.map((p) => ({
    id: p.id,
    name: p.name,
    gender: p.gender,
    color: p.color,
    blurb: p.blurb,
  })),
  topics: TOPICS,
  pacings: [
    { id: 'chill', label: 'Chill · slower pace', hint: '2.5–6s between lines' },
    { id: 'natural', label: 'Natural', hint: 'casual talking rhythm' },
    { id: 'lively', label: 'Lively', hint: 'quick back & forth' },
  ],
}));

// If the web build exists, serve it so `npm start` is a full standalone deploy.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
}

const io = new Server(app.server, {
  cors: { origin: true, credentials: false },
  maxHttpBufferSize: 1e6,
});
registerSockets(io);

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[server] AI Chat Room listening on http://${HOST}:${PORT}`);
});
