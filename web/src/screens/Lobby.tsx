import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Meta, RoomSummary, UserSettings } from '../types';
import { createRoom, listRooms } from '../socket';

interface Props {
  meta: Meta;
  settings: Partial<UserSettings>;
  onEditSettings: () => void;
  onOpenRoom: (roomId: string) => void;
}

function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function timeAgo(ts: number | null): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function Lobby({ meta, settings, onEditSettings, onOpenRoom }: Props) {
  const [personaIds, setPersonaIds] = useState<string[]>(() =>
    sample(meta.personas, 3).map((p) => p.id)
  );
  const [topicIds, setTopicIds] = useState<string[]>(() =>
    sample(meta.topics, 4).map((t) => t.id)
  );
  const [pacing, setPacing] = useState<'chill' | 'natural' | 'lively'>('natural');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const topicTitle = useMemo(
    () => new Map(meta.topics.map((t) => [t.id, t.title])),
    [meta.topics]
  );

  const refreshRooms = useCallback(() => {
    listRooms()
      .then((r) => setRooms(r.rooms))
      .catch(() => setRooms([]));
  }, []);

  useEffect(() => {
    refreshRooms();
  }, [refreshRooms]);

  const togglePersona = (id: string) => {
    setPersonaIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 2) return prev;
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= 6) return prev;
      return [...prev, id];
    });
  };

  const toggleTopic = (id: string) => {
    setTopicIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const create = async () => {
    if (!settings.apiKey) {
      onEditSettings();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { roomId } = await createRoom({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        pacing,
        personaIds,
        topicIds,
      });
      onOpenRoom(roomId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the room');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <header className="topbar">
        <div className="topbar-title">
          <div className="brand-mark small">AI</div>
          <h1>English Chat Room</h1>
        </div>
        <div className="topbar-actions">
          <span className="muted chip">Key: {settings.apiKey ? 'saved ✓' : 'missing'}</span>
          <button className="btn ghost" onClick={onEditSettings}>
            {settings.apiKey ? 'Change key' : 'Enter API key'}
          </button>
        </div>
      </header>

      <main className="lobby-grid">
        <section className="panel setup-panel">
          <h2>New chatroom</h2>
          <p className="muted">
            Pick who is in the room and what they usually talk about. They will chat by
            themselves — and you can jump in any time.
          </p>

          <div className="field-label">Characters in the room ({personaIds.length}/6)</div>
          <div className="persona-grid">
            {meta.personas.map((p) => {
              const on = personaIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  className={`persona-card ${on ? 'on' : ''}`}
                  style={{ '--accent': p.color } as React.CSSProperties}
                  onClick={() => togglePersona(p.id)}
                  title={p.blurb}
                >
                  <span className="avatar" style={{ background: p.color }}>
                    {p.name.slice(0, 1)}
                  </span>
                  <span className="persona-name">{p.name}</span>
                  <span className="persona-blurb">{p.blurb}</span>
                </button>
              );
            })}
          </div>

          <div className="field-label">Topics they chat about</div>
          <div className="chips">
            {meta.topics.map((t) => (
              <button
                key={t.id}
                className={`chip ${topicIds.includes(t.id) ? 'active' : ''}`}
                onClick={() => toggleTopic(t.id)}
              >
                {t.title}
              </button>
            ))}
          </div>

          <div className="field-label">Talking pace</div>
          <div className="pacing-row">
            {meta.pacings.map((p) => (
              <button
                key={p.id}
                className={`chip ${pacing === p.id ? 'active' : ''}`}
                onClick={() => setPacing(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {error && <p className="error">{error}</p>}

          <button className="btn primary wide" onClick={create} disabled={busy || topicIds.length === 0}>
            {busy ? 'Creating…' : 'Start chatting'}
          </button>
        </section>

        {rooms.length > 0 && (
          <aside className="panel rooms-panel">
            <h2>Continue a room</h2>
            <div className="room-list">
              {rooms.map((r) => {
                const names = r.config.personaIds
                  .map((id) => meta.personas.find((p) => p.id === id)?.name)
                  .filter(Boolean)
                  .join(', ');
                const topics = r.config.topicIds
                  .map((id) => topicTitle.get(id))
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <button
                    key={r.id}
                    className="room-card"
                    onClick={() => {
                      if (!settings.apiKey) return onEditSettings();
                      onOpenRoom(r.id);
                    }}
                  >
                    <div className="room-card-title">
                      {names}
                      <span className="muted"> · {r.config.pacing}</span>
                    </div>
                    <div className="room-card-sub muted">{topics || 'misc topics'}</div>
                    <div className="muted">{timeAgo(r.lastMessageAt)}</div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </main>

      <footer className="lobby-hint">
        Tip: open this page in Chrome or Edge for the best built-in English voices and
        microphone input. Closing the room tab pauses the chat so no tokens are used.
      </footer>
    </div>
  );
}
