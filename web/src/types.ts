// Shared wire types (mirrors the server payloads).

export interface PersonaPublic {
  id: string;
  name: string;
  gender: 'm' | 'f';
  color: string;
  blurb: string;
}

export interface Topic {
  id: string;
  title: string;
  seed: string;
}

export interface PacingOption {
  id: 'chill' | 'natural' | 'lively';
  label: string;
  hint: string;
}

export interface Meta {
  personas: PersonaPublic[];
  topics: Topic[];
  pacings: PacingOption[];
}

export interface MessageRow {
  id: string;
  roomId: string;
  role: 'ai' | 'user';
  personaId: string | null;
  name: string;
  content: string;
  createdAt: number;
  /** Simplified-Chinese translation of an AI line (absent for user rows). */
  zh?: string | null;
}

export interface PublicState {
  topic: string;
  paused: boolean;
  pacing: 'chill' | 'natural' | 'lively';
  personaIds: string[];
  listeners: number;
  running: boolean;
}

export interface RoomJoinResult {
  ok: boolean;
  roomId?: string;
  history?: MessageRow[];
  personas?: PersonaPublic[];
  pacing?: 'chill' | 'natural' | 'lively';
  state?: PublicState;
  error?: string;
}

export interface MsgStartPayload {
  id: string;
  personaId: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface MsgDonePayload extends MsgStartPayload {
  content: string;
}

export interface RoomSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  config: {
    pacing: 'chill' | 'natural' | 'lively';
    personaIds: string[];
    topicIds: string[];
  };
  lastMessageAt: number | null;
}

// settings stored in localStorage (apiKey stays in this browser)
export interface UserSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const KEY = 'english-chatroom:settings:v1';

export function loadSettings(): Partial<UserSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return {
      apiKey: parsed.apiKey ?? '',
      baseUrl: parsed.baseUrl ?? '',
      model: parsed.model ?? '',
    };
  } catch {
    return {};
  }
}

export function saveSettings(s: Partial<UserSettings>): void {
  const merged = { ...loadSettings(), ...s };
  localStorage.setItem(KEY, JSON.stringify(merged));
}
