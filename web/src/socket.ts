// Typed socket.io client helpers used by the UI.

import { io, type Socket } from 'socket.io-client';
import type {
  MsgDonePayload,
  MsgStartPayload,
  PublicState,
  RoomJoinResult,
  RoomSummary,
} from './types';

export interface SpeakingPayload {
  personaId: string | null;
  name?: string;
}

export interface UserMsgPayload {
  id: string;
  name: string;
  content: string;
  createdAt: number;
}

type WirePayloads = {
  speaking: SpeakingPayload;
  'msg:start': MsgStartPayload;
  'msg:delta': { id: string; delta: string };
  'msg:cancel': { id: string };
  'msg:done': MsgDonePayload;
  'msg:zh': { id: string; zh: string };
  userMsg: UserMsgPayload;
  topic: { title: string };
  paused: { paused: boolean };
  state: PublicState;
  error: { code: string; message: string };
};

export type WireEvent = keyof WirePayloads;

export type HandlerMap = {
  connect: () => void;
  disconnect: (reason: string) => void;
  connect_error: (err: Error) => void;
} & {
  [K in WireEvent]: (payload: WirePayloads[K]) => void;
};

let socket: Socket | null = null;

function ensureSocket(): Socket {
  if (!socket) {
    socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
  }
  return socket;
}

export function connect(): void {
  ensureSocket().connect();
}

export function disconnect(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function socketConnected(): boolean {
  return socket?.connected ?? false;
}

/** Subscribe to a set of socket events; returns a cleanup function. */
export function bindEvents(handlers: Partial<HandlerMap>): () => void {
  const s = ensureSocket();
  const unsubs: Array<() => void> = [];
  for (const [name, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    const wrap = (payload: unknown) => (handler as (p: unknown) => void)(payload);
    s.on(name, wrap);
    unsubs.push(() => s.off(name, wrap));
  }
  return () => unsubs.forEach((u) => u());
}

/** Emit and resolve the server ack. Throws if the server returned { ok: false }. */
export function call<T>(event: string, payload?: unknown): Promise<T> {
  const s = ensureSocket();
  return new Promise<T>((resolve, reject) => {
    s.emit(event, payload ?? {}, (res: T & { ok?: boolean; error?: string }) => {
      if (res && res.ok === false) {
        reject(new Error(res.error ?? 'request failed'));
      } else {
        resolve(res as T);
      }
    });
  });
}

export interface CreateRoomArgs {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  pacing: 'chill' | 'natural' | 'lively';
  personaIds: string[];
  topicIds: string[];
}

export function createRoom(args: CreateRoomArgs): Promise<{ roomId: string }> {
  return call<{ ok: true; roomId: string }>('room:create', args);
}

export interface JoinArgs {
  roomId: string;
  apiKey?: string;
  voice?: boolean;
}

export function joinRoom(args: JoinArgs): Promise<RoomJoinResult> {
  return call<RoomJoinResult>('room:join', args);
}

/** Tell the server whether this page will read lines aloud (voice pacing). */
export function setVoiceEnabled(on: boolean): void {
  const s = socket;
  if (s?.connected) s.emit('room:voice', { voice: on });
}

/** Ack that this page finished reading message `id` aloud (voice pacing). */
export function sendVoiceDone(id: string): void {
  const s = socket;
  if (s?.connected) s.emit('tts:done', { id });
}

/** Hush the AIs while the mic is held open (push-to-talk). */
export function sendUserSpeaking(active: boolean): void {
  const s = socket;
  if (s?.connected) s.emit('user:speaking', { active });
}

export function listRooms(): Promise<{ rooms: RoomSummary[] }> {
  return call<{ rooms: RoomSummary[] }>('room:list');
}

export function sendUserMessage(text: string): Promise<void> {
  return call<{ ok: true }>('user:msg', { text }).then(() => undefined);
}

export function setPaused(paused: boolean): Promise<void> {
  return call<{ ok: true }>('room:pause', { paused }).then(() => undefined);
}

export function leaveRoomServer(): Promise<void> {
  return call<{ ok: true }>('room:leave').then(
    () => undefined,
    () => undefined
  );
}
