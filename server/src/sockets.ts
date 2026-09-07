import type { Server, Socket } from 'socket.io';
import { ChatEngine } from './engine.js';
import { createRoom, getRoom, listRooms, messagesFor } from './db.js';
import { MAX_PERSONAS, MIN_PERSONAS, personaById, type Pacing } from './personas.js';

interface CreatePayload {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  pacing?: Pacing;
  personaIds?: string[];
  topicIds?: string[];
}

interface JoinPayload {
  roomId?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: boolean; // this page's speaker on/off at join time
}

interface Ack {
  (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }): void;
}

const engines = new Map<string, ChatEngine>();

export function registerSockets(io: Server): void {
  function roomSize(roomId: string): number {
    return io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
  }
  /** True while at least one page in the room has its speaker enabled. */
  function roomVoiceOn(roomId: string): boolean {
    const members = io.sockets.adapter.rooms.get(roomId);
    if (!members) return false;
    for (const sid of members) {
      const s = io.sockets.sockets.get(sid);
      if ((s?.data.voiceOn as boolean | undefined) !== false) return true;
    }
    return false;
  }
  /** Recompute whether the engine may pace itself on read-back acks. */
  function syncVoicePaced(roomId: string | null): void {
    if (!roomId) return;
    engines.get(roomId)?.setVoicePaced(roomVoiceOn(roomId));
  }
  function leaveRoom(socket: Socket): void {
    const roomId = socket.data.roomId as string | null;
    if (!roomId) return;
    socket.data.roomId = null;
    socket.leave(roomId);
    engines.get(roomId)?.setListeners(roomSize(roomId));
    syncVoicePaced(roomId);
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null as string | null;

    socket.on('room:create', (payload: CreatePayload, ack: Ack) => {
      wrap(ack, () => {
        const personaIds = (payload.personaIds ?? []).filter((p) => personaById(p));
        const topicIds = (payload.topicIds ?? []).filter((p) => p);
        const pacing: Pacing =
          payload.pacing === 'lively' || payload.pacing === 'natural' ? payload.pacing : 'chill';
        if (personaIds.length < MIN_PERSONAS || personaIds.length > MAX_PERSONAS) {
          throw new Error(`pick between ${MIN_PERSONAS} and ${MAX_PERSONAS} characters`);
        }
        if (topicIds.length === 0) throw new Error('pick at least one topic');

        const persisted = {
          baseUrl: payload.baseUrl || undefined,
          model: payload.model || undefined,
          pacing,
          personaIds,
          topicIds,
        };
        const roomId = createRoom(persisted);
        const engine = new ChatEngine(roomId, persisted, [], (evt) =>
          io.to(roomId).emit(evt.event, evt.payload)
        );
        engines.set(roomId, engine);
        if (payload.apiKey) {
          engine.attachKey({
            apiKey: payload.apiKey,
            baseUrl: persisted.baseUrl,
            model: persisted.model,
          });
        }
        ack({ ok: true, roomId });
      });
    });

    socket.on('room:list', (_payload, ack: Ack) => {
      ack({ ok: true, rooms: listRooms() });
    });

    socket.on('room:join', (payload: JoinPayload, ack: Ack) => {
      wrap(ack, async () => {
        if (!payload.roomId) throw new Error('missing room id');
        leaveRoom(socket);

        const row = getRoom(payload.roomId);
        if (!row) throw new Error('room not found');
        const persisted = JSON.parse(row.config) as {
          baseUrl?: string;
          model?: string;
          pacing: Pacing;
          personaIds: string[];
          topicIds: string[];
        };

        let engine = engines.get(row.id);
        if (!engine) {
          const history = messagesFor(row.id);
          engine = new ChatEngine(row.id, persisted, history, (evt) =>
            io.to(row.id).emit(evt.event, evt.payload)
          );
          engines.set(row.id, engine);
        }
        const creds = {
          apiKey: payload.apiKey || '',
          baseUrl: persisted.baseUrl,
          model: persisted.model,
        };
        if (creds.apiKey) engine.attachKey(creds);

        socket.join(row.id);
        socket.data.roomId = row.id;
        socket.data.voiceOn = payload.voice !== false; // pages default to speaking
        engine.setListeners(roomSize(row.id));
        // A fresh page joining clears any stale "mic is open" hush from a page
        // that disconnected mid-sentence.
        engine.setUserSpeaking(false);
        syncVoicePaced(row.id);

        const personas = persisted.personaIds
          .map((id) => personaById(id))
          .filter((p) => p !== undefined)
          .map((p) => ({ id: p.id, name: p.name, gender: p.gender, color: p.color, blurb: p.blurb }));

        ack({
          ok: true,
          roomId: row.id,
          history: messagesFor(row.id),
          personas,
          pacing: persisted.pacing,
          state: engine.publicState(),
        });
      });
    });

    socket.on('user:msg', (payload: { roomId?: string; text?: string }, ack: Ack) => {
      const roomId = (payload.roomId || socket.data.roomId) as string | null;
      const engine = roomId ? engines.get(roomId) : undefined;
      if (!engine) {
        ack?.({ ok: false, error: 'not in a room' });
        return;
      }
      engine.handleUserMessage(String(payload.text ?? ''));
      ack({ ok: true });
    });

    socket.on('room:pause', (payload: { paused?: boolean }, ack: Ack) => {
      const engine = socket.data.roomId ? engines.get(socket.data.roomId) : undefined;
      if (!engine) {
        ack?.({ ok: false, error: 'not in a room' });
        return;
      }
      engine.setPaused(Boolean(payload.paused));
      ack({ ok: true });
    });

    socket.on('room:voice', (payload: { voice?: boolean }, ack?: Ack) => {
      socket.data.voiceOn = payload?.voice !== false;
      syncVoicePaced(socket.data.roomId as string | null);
      ack?.({ ok: true });
    });

    socket.on('tts:done', (payload: { id?: string }) => {
      const roomId = socket.data.roomId as string | null;
      if (!roomId || !payload?.id) return;
      engines.get(roomId)?.onSpeechDone(String(payload.id));
    });

    socket.on('user:speaking', (payload: { active?: boolean }, ack?: Ack) => {
      const roomId = socket.data.roomId as string | null;
      if (!roomId) {
        ack?.({ ok: false, error: 'not in a room' });
        return;
      }
      engines.get(roomId)?.setUserSpeaking(Boolean(payload?.active));
      ack?.({ ok: true });
    });

    socket.on('room:leave', (_, ack: Ack) => {
      leaveRoom(socket);
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => leaveRoom(socket));
  });
}

function wrap(ack: Ack | undefined, fn: () => Promise<unknown> | unknown): void {
  const reply = ack ?? (() => undefined);
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((err) => reply({ ok: false, error: messageOf(err) }));
    }
  } catch (err) {
    reply({ ok: false, error: messageOf(err) });
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
