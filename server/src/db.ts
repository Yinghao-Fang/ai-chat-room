// SQLite persistence for rooms & message history.
// Uses Node's built-in `node:sqlite` (Node >= 23) so there is no native compile step.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface MessageRow {
  id: string;
  roomId: string;
  role: 'ai' | 'user';
  personaId: string | null;
  name: string;
  content: string;
  createdAt: number;
  /** Simplified-Chinese translation of an AI line (null when absent). */
  zh: string | null;
}

export interface RoomRow {
  id: string;
  config: string; // JSON of persisted settings (apiKey is never stored here)
  createdAt: number;
  updatedAt: number;
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(rootDir, 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'chatroom.db');

const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    role TEXT NOT NULL,
    persona_id TEXT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    zh TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
`);

// Existing databases were created without the zh column - add it when missing.
try {
  db.exec('ALTER TABLE messages ADD COLUMN zh TEXT');
} catch {
  /* column already exists */
}

const stmts = {
  insertRoom: db.prepare(
    'INSERT INTO rooms (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ),
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  touchRoom: db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?'),
  listRooms: db.prepare('SELECT * FROM rooms ORDER BY updated_at DESC LIMIT 20'),
  lastMessageAt: db.prepare(
    'SELECT MAX(created_at) AS last_at FROM messages WHERE room_id = ?'
  ),
  insertMessage: db.prepare(
    'INSERT INTO messages (id, room_id, role, persona_id, name, content, zh, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  updateMessageZh: db.prepare('UPDATE messages SET zh = ? WHERE id = ?'),
  getMessages: db.prepare(
    'SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC, rowid ASC'
  ),
};

export function createRoom(persistedConfig: unknown): string {
  const id = randomUUID();
  const now = Date.now();
  stmts.insertRoom.run(id, JSON.stringify(persistedConfig), now, now);
  return id;
}

export function getRoom(id: string): RoomRow | null {
  const row = stmts.getRoom.get(id) as RoomRow | undefined;
  return row ?? null;
}

export function touchRoom(id: string): void {
  stmts.touchRoom.run(Date.now(), id);
}

export interface RoomSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  config: unknown;
  lastMessageAt: number | null;
}

export function listRooms(): RoomSummary[] {
  const rooms = stmts.listRooms.all() as unknown as RoomRow[];
  return rooms.map((r) => {
    const last = stmts.lastMessageAt.get(r.id) as { last_at: number | null };
    return {
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      config: safeJson(r.config),
      lastMessageAt: last.last_at ?? null,
    };
  });
}

export function insertMessage(m: {
  roomId: string;
  role: 'ai' | 'user';
  personaId?: string | null;
  name: string;
  content: string;
  zh?: string | null;
}): MessageRow {
  const row: MessageRow = {
    id: randomUUID(),
    roomId: m.roomId,
    role: m.role,
    personaId: m.personaId ?? null,
    name: m.name,
    content: m.content,
    zh: m.zh ?? null,
    createdAt: Date.now(),
  };
  stmts.insertMessage.run(
    row.id,
    row.roomId,
    row.role,
    row.personaId,
    row.name,
    row.content,
    row.zh,
    row.createdAt
  );
  touchRoom(row.roomId);
  return row;
}

/** Store the translated line once it is ready (translation runs in the background). */
export function updateMessageZh(id: string, zh: string): void {
  stmts.updateMessageZh.run(zh, id);
}

export function messagesFor(roomId: string): MessageRow[] {
  return stmts.getMessages.all(roomId) as unknown as MessageRow[];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
