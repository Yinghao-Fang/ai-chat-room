// ChatEngine: server-side autonomous chatroom director.
// A room talks by itself while at least one listener is connected and it is not
// paused. When the last listener disconnects the engine idles (and aborts any
// in-flight generation) so no tokens are spent while nobody is watching.

import {
  TOPICS,
  type Pacing,
  type Persona,
  personaById,
  topicById,
} from './personas.js';
import type { MessageRow } from './db.js';
import { insertMessage, updateMessageZh } from './db.js';
import { streamChat, chatOnce, type LLMCredentials, LLMError } from './llm.js';

export const CONTEXT_WINDOW = 24; // how many recent messages go into the LLM prompt

export type EngineEvent =
  | { event: 'speaking'; payload: { personaId: string | null; name?: string } }
  | { event: 'msg:start'; payload: MsgStart }
  | { event: 'msg:delta'; payload: { id: string; delta: string } }
  | { event: 'msg:cancel'; payload: { id: string } }
  | { event: 'msg:done'; payload: AiMessageOut }
  | { event: 'msg:zh'; payload: { id: string; zh: string } }
  | { event: 'userMsg'; payload: UserMsgOut }
  | { event: 'topic'; payload: { title: string } }
  | { event: 'paused'; payload: { paused: boolean } }
  | { event: 'state'; payload: PublicState }
  | { event: 'error'; payload: { code: string; message: string } };

export interface MsgStart {
  id: string;
  personaId: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface AiMessageOut extends MsgStart {
  content: string;
}

export interface UserMsgOut {
  id: string;
  name: string;
  content: string;
  createdAt: number;
}

export interface PublicState {
  topic: string;
  paused: boolean;
  pacing: Pacing;
  personaIds: string[];
  listeners: number;
  running: boolean;
}

type Emitter = (evt: EngineEvent) => void;

interface PersistedRoomConfig {
  baseUrl?: string;
  model?: string;
  pacing: Pacing;
  personaIds: string[];
  topicIds: string[];
}

type NextAction =
  | { kind: 'greeting' }
  | { kind: 'speak'; persona: Persona; replyingToUser: boolean }
  | { kind: 'topicShift'; persona: Persona };

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

export class ChatEngine {
  readonly roomId: string;
  private settings: PersistedRoomConfig;
  private apiKey: string | null = null;
  private emit: Emitter;

  private personas: Persona[] = [];
  private topicCycle: string[] = []; // titles
  private topicIndex = -1;
  topicTitle = '';

  private history: MessageRow[] = [];
  private activeListeners = 0;
  private manualPause = false;
  private busy = false;
  private hasStarted = false;

  private pendingUserReplies = 0;
  private aiStreak = 0; // consecutive AI turns since the last human message
  private turnsOnTopic = 0;
  private turnsBeforeSwitch = rand(4, 7);

  private lastAiSpeakerId: string | null = null;
  private nextTimer: NodeJS.Timeout | null = null;
  private genAbort: AbortController | null = null;
  private destroyed = false;

  // Voice-paced mode: the engine waits for the listener's browser to finish
  // reading a line aloud before it schedules the next one. If the client has
  // voice off (or unavailable), it acks immediately so pacing stays fixed.
  private voicePaced = true;
  private awaitingSpeechId: string | null = null;
  private speechWaitTimer: NodeJS.Timeout | null = null;
  private speechWaitMs = 30_000;

  // Hard hush: set while the human's mic is open (push-to-talk). While it is on,
  // the AIs stay completely quiet - no scheduling, no read-back wait, and any
  // in-flight generation is aborted so nothing finishes over their voice.
  private userSpeaking = false;

  constructor(
    roomId: string,
    persisted: PersistedRoomConfig,
    dbHistory: MessageRow[],
    emit: Emitter
  ) {
    this.roomId = roomId;
    this.settings = persisted;
    this.emit = emit;

    this.personas = persisted.personaIds
      .map((id) => personaById(id))
      .filter((p): p is Persona => Boolean(p));

    const topics = persisted.topicIds
      .map((id) => topicById(id))
      .filter((t) => t !== undefined);
    // deterministic-ish shuffle then a random starting point
    const order = topics.length ? topics : TOPICS;
    this.topicCycle = shuffle(order).map((t) => t.title);
    this.topicIndex = Math.floor(Math.random() * this.topicCycle.length);
    this.topicTitle = this.topicCycle[this.topicIndex];

    this.history = dbHistory;
    // infer streak/state from history so resume is natural
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === 'user') break;
      this.aiStreak++;
    }
    if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      if (last.role === 'ai' && last.personaId) this.lastAiSpeakerId = last.personaId;
    }
    this.hasStarted = this.history.length > 0;
  }

  // ---- control from sockets ----

  attachKey(creds: LLMCredentials): void {
    this.apiKey = creds.apiKey || null;
    this.ensureScheduled();
  }

  /** Driven by socket.io's actual room membership (single source of truth). */
  setListeners(count: number): void {
    const n = Math.max(0, count);
    if (n === this.activeListeners) return;
    this.activeListeners = n;
    if (n === 0) {
      // Nobody is watching: stop spending tokens immediately.
      this.genAbort?.abort();
      this.clearTimer();
      this.clearSpeechWait();
    } else {
      // A (possibly new) page just joined: any pending "wait for voice" from a
      // previous session is void - treat the line as finished and carry on.
      this.clearSpeechWait();
      this.ensureScheduled(600);
    }
    this.pushState();
  }

  get listenerCount(): number {
    return this.activeListeners;
  }

  setPaused(paused: boolean): void {
    this.manualPause = paused;
    this.emit({ event: 'paused', payload: { paused } });
    this.pushState();
    if (!paused) this.ensureScheduled();
  }

  handleUserMessage(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const row = insertMessage({
      roomId: this.roomId,
      role: 'user',
      personaId: null,
      name: 'You',
      content: clean,
    });
    this.history.push(row);
    this.emit({
      event: 'userMsg',
      payload: {
        id: row.id,
        name: 'You',
        content: row.content,
        createdAt: row.createdAt,
      },
    });
    this.pendingUserReplies++;
    this.aiStreak = 0;
    // A human just spoke/typed: don't keep waiting for the previous line to be
    // read aloud (they interrupted it anyway).
    this.clearSpeechWait();
    this.ensureScheduled(400);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    this.clearSpeechWait();
    this.genAbort?.abort();
  }

  /** Let the engine know whether the listener's browser will read lines aloud. */
  setVoicePaced(voiceOn: boolean): void {
    if (this.voicePaced === voiceOn) return;
    this.voicePaced = voiceOn;
    if (!voiceOn) {
      // No audio: don't wait for a read-back that will never come.
      const wasWaiting = this.awaitingSpeechId !== null;
      this.clearSpeechWait();
      if (wasWaiting) this.ensureScheduled();
    }
  }

  /** The listener's browser finished reading message `id` aloud. */
  onSpeechDone(id: string): void {
    if (!this.voicePaced) return;
    if (this.awaitingSpeechId !== id) return;
    this.clearSpeechWait();
    if (this.canRun()) this.ensureScheduled(300);
  }

  /**
   * Hard hush while the human's mic is open. On: drop any pending line and abort
   * an in-flight generation so nothing talks over them. Off: let the room pick
   * back up (replying to whatever they just said, or the next autonomous line).
   */
  setUserSpeaking(on: boolean): void {
    if (this.userSpeaking === on) return;
    this.userSpeaking = on;
    if (on) {
      this.clearTimer();
      this.clearSpeechWait();
      this.genAbort?.abort();
    } else {
      this.ensureScheduled(300);
    }
    this.pushState();
  }

  private clearSpeechWait(): void {
    if (this.speechWaitTimer) {
      clearTimeout(this.speechWaitTimer);
      this.speechWaitTimer = null;
    }
    this.awaitingSpeechId = null;
  }

  private armSpeechWait(id: string): void {
    this.awaitingSpeechId = id;
    if (this.speechWaitTimer) clearTimeout(this.speechWaitTimer);
    // Safety net: never stall the room forever on a missing read-back ack.
    this.speechWaitTimer = setTimeout(() => {
      this.speechWaitTimer = null;
      if (this.awaitingSpeechId === id) {
        this.clearSpeechWait();
        if (this.canRun()) this.ensureScheduled();
      }
    }, this.speechWaitMs);
  }

  publicState(): PublicState {
    return {
      topic: this.topicTitle,
      paused: this.manualPause,
      pacing: this.settings.pacing,
      personaIds: this.personas.map((p) => p.id),
      listeners: this.activeListeners,
      running: this.busy || this.nextTimer !== null,
    };
  }

  // ---- scheduling ----

  private ensureScheduled(delay = rand(500, 1200)): void {
    if (!this.canRun() || this.busy) return;
    if (this.voicePaced && this.awaitingSpeechId) return; // wait for the line to be read
    this.clearTimer();
    this.nextTimer = setTimeout(() => void this.tick(), delay);
  }

  private clearSpeechWaitAndRun(delay = rand(500, 1200)): void {
    this.clearSpeechWait();
    this.ensureScheduled(delay);
  }

  private canRun(): boolean {
    if (this.destroyed || this.activeListeners <= 0 || !this.apiKey) return false;
    if (this.userSpeaking) return false; // the human's mic is open - stay quiet
    // While manually paused the AIs stay quiet — unless a human just spoke to them.
    if (this.manualPause) return this.pendingUserReplies > 0;
    return true;
  }

  private clearTimer(): void {
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
  }

  private pushState(): void {
    this.emit({ event: 'state', payload: this.publicState() });
  }

  private async tick(): Promise<void> {
    this.nextTimer = null;
    if (!this.canRun() || this.busy) {
      this.pushState();
      return;
    }
    await this.runOneTurn();
  }

  // ---- turn logic ----

  private async runOneTurn(): Promise<void> {
    this.busy = true;
    this.pushState();
    const action = this.decideNext();
    let speaker: Persona;
    if (action.kind === 'greeting') {
      speaker = this.pickLeastRecent([]);
    } else {
      speaker = action.persona;
    }
    if (!speaker) {
      this.busy = false;
      return;
    }

    const kind: 'greeting' | 'speak' | 'topicShift' =
      action.kind === 'topicShift' ? 'topicShift' : action.kind === 'greeting' ? 'greeting' : 'speak';

    if (action.kind === 'topicShift') {
      this.advanceTopic();
      this.emit({ event: 'topic', payload: { title: this.topicTitle } });
    }

    this.emit({
      event: 'speaking',
      payload: { personaId: speaker.id, name: speaker.name },
    });

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.emit({
      event: 'msg:start',
      payload: { id, personaId: speaker.id, name: speaker.name, color: speaker.color, createdAt },
    });

    const abort = new AbortController();
    this.genAbort = abort;

    let content = '';
    try {
      const { system, user } = this.buildPrompt(speaker, kind, action);
      let lastFlush = 0;
      let buffer = '';
      const flush = () => {
        if (!buffer) return;
        this.emit({ event: 'msg:delta', payload: { id, delta: buffer } });
        buffer = '';
      };

      for await (const delta of streamChat(
        { apiKey: this.apiKey!, baseUrl: this.settings.baseUrl, model: this.settings.model },
        system,
        user,
        { signal: abort.signal, temperature: 1.0, maxTokens: 380 }
      )) {
        content += delta;
        buffer += delta;
        const now = Date.now();
        if (now - lastFlush > 60) {
          flush();
          lastFlush = now;
        }
      }
      flush();

      content = content.trim().replace(/^["']|["']$/g, '');
      if (!content) throw new LLMError(0, 'empty reply');
    } catch (err) {
      this.genAbort = null;
      this.busy = false;
      this.emit({ event: 'speaking', payload: { personaId: null } });
      if (err instanceof Error && err.name === 'AbortError') {
        // Room went quiet (or the human opened their mic) mid-generation: nothing
        // was persisted. Drop the half-streamed caption so it doesn't linger.
        this.emit({ event: 'msg:cancel', payload: { id } });
        // If the abort wasn't a hard stop (e.g. the mic was released again),
        // let a fresh turn be scheduled; otherwise canRun() keeps us idle.
        if (this.canRun()) this.ensureScheduled(300);
        return;
      }
      this.emit({ event: 'msg:cancel', payload: { id } });
      const message =
        err instanceof LLMError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'unknown error';
      this.emit({
        event: 'error',
        payload: { code: 'llm', message: `Failed to reach the AI service: ${message}` },
      });
      return;
    }

    this.genAbort = null;

    const row = insertMessage({
      roomId: this.roomId,
      role: 'ai',
      personaId: speaker.id,
      name: speaker.name,
      content,
    });
    this.history.push(row);

    this.emit({
      event: 'msg:done',
      payload: { id, personaId: speaker.id, name: speaker.name, color: speaker.color, createdAt, content },
    });
    this.emit({ event: 'speaking', payload: { personaId: null } });

    // Chinese translation runs in the background so English captioning, voice
    // reading and pacing are never delayed by it.
    void this.translateLine(row.id, id, content);

    // bookkeeping
    if (action.kind === 'speak' && action.replyingToUser) {
      this.pendingUserReplies = Math.max(0, this.pendingUserReplies - 1);
    }
    this.lastAiSpeakerId = speaker.id;
    this.turnsOnTopic++;
    this.aiStreak++;
    this.hasStarted = true;

    this.busy = false;
    this.pushState();

    // Voice-paced: don't fetch the next line until the current one has actually
    // been read aloud. This is the lockstep that stops captions outrunning the
    // voice — the browser acks `msg:done` id once its reader finishes the line.
    // (While the human's mic is open they won't read it, so skip the wait and
    // let setUserSpeaking(false) pick things back up.)
    if (this.voicePaced && this.activeListeners > 0 && !this.userSpeaking) {
      this.armSpeechWait(id);
    }

    // schedule the next beat with a human-feeling pause
    // (no-op while we are still waiting for the line above to be read aloud)
    if (this.canRun()) {
      this.ensureScheduled(this.nextPauseMs());
    }
  }

  /**
   * Background Simplified-Chinese translation of a finished AI line. Best-effort:
   * failures are swallowed so they never interrupt the room.
   */
  private async translateLine(dbId: string, liveId: string, content: string): Promise<void> {
    const apiKey = this.apiKey;
    if (!apiKey || !content.trim()) return;
    try {
      const zh = await chatOnce(
        {
          apiKey,
          baseUrl: this.settings.baseUrl,
          model: this.settings.model,
        },
        'You are a precise translator. Translate the user\'s English chat line into natural, everyday Simplified Chinese. Output ONLY the Chinese translation - no quotes, no notes, no English.',
        content,
        { temperature: 0.3, maxTokens: 320 }
      );
      const clean = zh.replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/g, '').trim();
      if (!clean || this.destroyed) return;
      updateMessageZh(dbId, clean);
      this.emit({ event: 'msg:zh', payload: { id: liveId, zh: clean } });
    } catch {
      // Translation is best-effort; never spam the chat with errors.
    }
  }

  private nextPauseMs(): number {
    const base =
      this.settings.pacing === 'lively'
        ? rand(1000, 2400)
        : this.settings.pacing === 'natural'
          ? rand(1800, 4200)
          : rand(3200, 6500);
    // as the AIs chat on without the human, add occasional long lulls
    if (this.aiStreak > 3 && Math.random() < Math.min(0.4, this.aiStreak * 0.05)) {
      return base + rand(3000, 8000);
    }
    return base;
  }

  private decideNext(): NextAction {
    if (!this.hasStarted || this.history.length === 0) {
      return { kind: 'greeting' };
    }
    if (this.pendingUserReplies > 0) {
      const persona = this.pickLeastRecent([this.lastAiSpeakerId].filter(Boolean) as string[]);
      return { kind: 'speak', persona, replyingToUser: true };
    }
    if (this.turnsOnTopic >= this.turnsBeforeSwitch) {
      const persona = this.pickLeastRecent([this.lastAiSpeakerId].filter(Boolean) as string[]);
      return { kind: 'topicShift', persona };
    }
    const persona = this.pickLeastRecent([this.lastAiSpeakerId].filter(Boolean) as string[]);
    return { kind: 'speak', persona, replyingToUser: false };
  }

  /** Prefer personas that have spoken least recently so no one dominates. */
  private pickLeastRecent(exclude: string[]): Persona {
    const pool = this.personas.filter((p) => !exclude.includes(p.id));
    const candidates = pool.length ? pool : this.personas;
    const recent = this.history.slice(-10);
    const scored = candidates.map((p) => {
      const count = recent.filter((m) => m.personaId === p.id).length;
      return { p, count };
    });
    scored.sort((a, b) => a.count - b.count || Math.random() - 0.5);
    const best = scored[0]?.p ?? this.personas[0];
    return best;
  }

  private advanceTopic(): void {
    this.topicIndex = (this.topicIndex + 1) % this.topicCycle.length;
    this.topicTitle = this.topicCycle[this.topicIndex];
    this.turnsOnTopic = 0;
    this.turnsBeforeSwitch = rand(4, 7);
  }

  // ---- prompt building ----

  private buildPrompt(
    speaker: Persona,
    kind: 'greeting' | 'speak' | 'topicShift',
    action: NextAction
  ): { system: string; user: string } {
    const roster = this.personas.map((p) => p.name).join(', ');
    const lines: string[] = [
      speaker.system,
      '',
      `You are in a relaxed, friendly group chat. The other members are: ${roster}.`,
      `Right now the group is talking about: "${this.topicTitle}".`,
      '',
      'Rules for everything you say:',
      '- Speak ONLY as yourself. Output your spoken lines only: no quotes, no "Name:" prefixes, no stage directions, no commentary about the chat.',
      '- Use natural everyday English, like real people talking, never stilted or essay-like.',
      '- Keep it short and conversational: usually 1-3 sentences. You may go a little longer only when telling a story or explaining something.',
      '- React to what was just said, connect to earlier points when it fits, and ask questions now and then to keep things moving.',
      '- Never repeat yourself or restate what someone else said.',
      '- Do not pretend to be other members or speak for them.',
      '- A real person may join the conversation at any time; treat their messages naturally.',
    ];

    const recent = this.history.slice(-CONTEXT_WINDOW);
    let transcript: string;
    if (recent.length === 0 && kind === 'greeting') {
      transcript =
        'There is no conversation yet - you are starting it fresh. Say hi to the others and bring up something to talk about.';
    } else {
      const body = recent
        .map((m) => `${m.role === 'user' ? 'You (a real person)' : m.name}: ${m.content}`)
        .join('\n');
      const omitted = this.history.length > recent.length
        ? '\n\n(earlier parts of the chat were omitted)'
        : '';
      transcript = `Conversation so far (oldest first):\n${body}${omitted}`;
    }

    if (kind === 'greeting') {
      lines.push(`You are kicking off the conversation about "${this.topicTitle}".`);
    } else if (kind === 'topicShift') {
      lines.push(
        `The conversation should now naturally drift toward a new topic: "${this.topicTitle}". Bridge into it smoothly from what was being discussed - do not announce the topic formally.`
      );
    } else if (action.kind === 'speak' && action.replyingToUser) {
      const lastUser = [...this.history].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        lines.push(
          `A real person just joined the chat and said: "${lastUser.content}". React to what they said, answer if there is a question, and keep it easy for them to follow along.`
        );
      }
    }

    const user = `${transcript}\n\n---\nNow continue as ${speaker.name}. Say your next line(s).`;
    return { system: lines.join('\n'), user };
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
