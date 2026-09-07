import { useCallback, useEffect, useRef, useState } from 'react';
import { bindEvents, connect, joinRoom, sendUserMessage, setPaused, socketConnected, leaveRoomServer, setVoiceEnabled, sendVoiceDone, sendUserSpeaking } from '../socket';
import type { Meta, PersonaPublic, UserSettings, MessageRow } from '../types';
import { speaker } from '../tts';
import { asrSupported, MicRecorder } from '../asr';

interface Props {
  roomId: string;
  meta: Meta;
  settings: Partial<UserSettings>;
  onLeave: () => void;
}

interface Item {
  key: string;
  role: 'ai' | 'user';
  name: string;
  color: string;
  content: string;
  ts: number;
  zh?: string;
  streaming?: boolean;
}

export function Room({ roomId, meta, settings, onLeave }: Props) {
  const [joined, setJoined] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [personas, setPersonas] = useState<PersonaPublic[]>([]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [paused, setPausedUi] = useState(false);
  const [conn, setConn] = useState<'connecting' | 'connected' | 'reconnecting' | 'offline'>(
    'connecting'
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [micState, setMicState] = useState<'idle' | 'listening'>('idle');
  const [interim, setInterim] = useState('');
  const [micErr, setMicErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const personasRef = useRef(personas);
  personasRef.current = personas;
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const joinedRoomRef = useRef(false);
  const joiningRef = useRef(false);
  const recorderRef = useRef<MicRecorder | null>(null);
  const recordingRef = useRef(false);
  const lastFinalRef = useRef('');

  const scrollToBottom = useCallback((force = false) => {
    const el = listRef.current;
    if (!el) return;
    if (force || nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [items, scrollToBottom]);

  const getPersona = useCallback(
    (id?: string | null): PersonaPublic | undefined => {
      if (!id) return undefined;
      return (
        personasRef.current.find((p) => p.id === id) ??
        metaRef.current.personas.find((p) => p.id === id)
      );
    },
    []
  );

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    try {
      await sendUserMessage(t);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to send message');
    }
  }, []);

  const doJoin = useCallback(async () => {
    if (joiningRef.current) return;
    joiningRef.current = true;
    try {
      const res = await joinRoom({ roomId, apiKey: settingsRef.current.apiKey, voice: voiceOnRef.current });
      if (!res.ok || !res.history || !res.personas || !res.state) {
        throw new Error(res.error || 'Failed to join the room');
      }
      setItems(
        res.history.map((m: MessageRow) => {
          const persona = res.personas?.find((p) => p.id === m.personaId);
          return {
            key: m.id,
            role: m.role,
            name: m.role === 'user' ? 'You' : m.name,
            color: persona?.color ?? '#93a4b8',
            content: m.content,
            ts: m.createdAt,
            zh: m.role === 'ai' ? (m.zh ?? undefined) : undefined,
          };
        })
      );
      setPersonas(res.personas ?? []);
      setTopic(res.state.topic);
      setPausedUi(res.state.paused);
      setConn('connected');
      setErrorMsg(null);
      setJoined(true);
      joinedRoomRef.current = true;
      setTimeout(() => scrollToBottom(true), 60);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to join room');
    } finally {
      joiningRef.current = false;
    }
  }, [roomId, scrollToBottom]);

  useEffect(() => {
    connect();
    const unsub = bindEvents({
      connect: () => {
        setConn('connected');
        void doJoin();
      },
      disconnect: () => {
        setConn(joinedRoomRef.current ? 'reconnecting' : 'connecting');
      },
      connect_error: () => setConn('offline'),
      speaking: (p) => setSpeakingId(p.personaId),
      'msg:start': (p) => {
        setItems((prev) => [
          ...prev,
          { key: p.id, role: 'ai', name: p.name, color: p.color, content: '', ts: p.createdAt, streaming: true },
        ]);
      },
      'msg:delta': (p) => {
        setItems((prev) =>
          prev.map((it) =>
            it.key === p.id && it.streaming ? { ...it, content: it.content + p.delta } : it
          )
        );
      },
      'msg:cancel': (p) => {
        setItems((prev) => prev.filter((it) => it.key !== p.id));
        setSpeakingId(null);
      },
      'msg:done': (p) => {
        setItems((prev) =>
          prev.map((it) =>
            it.key === p.id ? { ...it, content: p.content, streaming: false } : it
          )
        );
        const persona = getPersona(p.personaId);
        if (voiceOnRef.current && persona && !recordingRef.current)
          speaker.speak(p.id, persona.gender, p.content);
      },
      'msg:zh': (p) => {
        setItems((prev) =>
          prev.map((it) => (it.key === p.id && it.role === 'ai' ? { ...it, zh: p.zh } : it))
        );
      },
      userMsg: (p) => {
        setItems((prev) => [
          ...prev,
          { key: p.id, role: 'user', name: 'You', color: '', content: p.content, ts: p.createdAt },
        ]);
      },
      topic: (p) => setTopic(p.title),
      paused: (p) => setPausedUi(p.paused),
      state: (s) => {
        setTopic(s.topic);
        setPausedUi(s.paused);
      },
      error: (e) => setErrorMsg(e.message),
    });

    if (socketConnected()) void doJoin();

    return () => {
      unsub();
      if (joinedRoomRef.current) void leaveRoomServer();
    };
  }, [roomId, doJoin, getPersona, scrollToBottom]);

  useEffect(() => {
    speaker.setOnLineDone((id) => sendVoiceDone(id));
    return () => {
      speaker.setOnLineDone(null);
      speaker.stop();
    };
  }, []);

  const toggleVoice = () => {
    const next = !voiceOn;
    speaker.stop();
    speaker.setMuted(!next);
    setVoiceOn(next);
    setVoiceEnabled(next);
  };

  const togglePause = () => void setPaused(!paused);

  const handleMicPress = useCallback(() => {
    if (!asrSupported) {
      setMicErr('Voice input is not supported in this browser. Try Chrome or Edge, or type instead.');
      return;
    }
    speaker.stop();
    sendUserSpeaking(true); // hush the AIs while the mic is held open
    if (!recorderRef.current) recorderRef.current = new MicRecorder();
    recordingRef.current = true;
    lastFinalRef.current = '';
    setMicErr(null);
    setMicState('listening');
    setInterim('');
    const ok = recorderRef.current.start('en-US', {
      onResult: (finalText, interimText) => {
        setInterim(interimText);
        if (finalText && finalText !== lastFinalRef.current) {
          lastFinalRef.current = finalText;
          void send(finalText);
        }
      },
      onError: (e) => {
        sendUserSpeaking(false);
        setMicErr(e === 'not-allowed' ? 'Microphone access was denied.' : `Mic error: ${e}`);
      },
      onEnd: () => {
        if (recordingRef.current) {
          recordingRef.current = false;
          setMicState('idle');
          setInterim('');
          sendUserSpeaking(false); // mic closed - let the AIs talk again
        }
      },
    });
    if (!ok) {
      recordingRef.current = false;
      sendUserSpeaking(false);
      setMicState('idle');
      return;
    }
    const release = () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      if (recordingRef.current) recorderRef.current?.stop();
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }, [send]);

  const submitDraft = () => {
    if (!draft.trim()) return;
    void send(draft);
    setDraft('');
  };

  return (
    <div className="room-shell">
      <header className="room-header">
        <div className="room-header-left">
          <button className="btn ghost" onClick={onLeave}>
            ← Rooms
          </button>
          <div className="topic-block">
            <span className="topic-chip">{topic || '…'}</span>
            <span className="conn-dot" data-state={conn} />
            <span className="muted">
              {conn === 'offline' ? 'server offline' : conn === 'reconnecting' ? 'reconnecting' : 'live'}
            </span>
          </div>
        </div>
        <div className="room-personas">
          {personas.map((p) => (
            <div key={p.id} className={`room-persona ${speakingId === p.id ? 'active' : ''}`}>
              <span className="avatar" style={{ background: p.color }}>
                {p.name.slice(0, 1)}
              </span>
              <span className="persona-name">{p.name}</span>
            </div>
          ))}
          <div className="room-controls">
            <button
              className={`btn ghost ${voiceOn ? '' : 'off'}`}
              onClick={toggleVoice}
              title="toggle spoken voice"
            >
              {voiceOn ? 'Voice on' : 'Voice off'}
            </button>
            <button className="btn ghost" onClick={togglePause}>
              {paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
          </div>
        </div>
      </header>

      <main className="captions" ref={listRef} onScroll={handleScroll}>
        {items.length === 0 && (
          <div className="empty-chat">
            <p>Everyone is arriving… the talk starts in a moment.</p>
            <p className="muted">Hold the mic or type below to jump in any time.</p>
          </div>
        )}
        {items.map((it) =>
          it.role === 'user' ? (
            <div key={it.key} className="msg user">
              <div className="msg-bubble user-bubble">{it.content}</div>
              <span className="msg-meta muted">You</span>
            </div>
          ) : (
            <div key={it.key} className={`msg ai ${it.streaming ? 'streaming' : ''}`}>
              <span className="avatar small" style={{ background: it.color }}>
                {it.name.slice(0, 1)}
              </span>
              <div className="ai-body">
                <span className="msg-name" style={{ color: it.color }}>
                  {it.name}
                </span>
                <div className={`ai-lines${it.zh ? ' with-zh' : ''}`}>
                  <div className="msg-bubble">
                    {it.content || '…'}
                    {it.streaming && <span className="caret" />}
                  </div>
                  {it.zh && <div className="translation">{it.zh}</div>}
                </div>
              </div>
            </div>
          )
        )}
      </main>

      {paused && (
        <div className="strip info">
          <span>Paused — the AI stay quiet until you talk.</span>
          <button className="btn small" onClick={togglePause}>
            Resume
          </button>
        </div>
      )}

      {micState === 'listening' && (
        <div className="strip listening">
          <span className="pulse-dot" />
          {interim ? <b>{interim}</b> : <span>Listening… speak now</span>}
        </div>
      )}

      {micErr && (
        <div className="strip error">
          <span>{micErr}</span>
          <button className="btn small ghost" onClick={() => setMicErr(null)}>
            ok
          </button>
        </div>
      )}

      <div className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitDraft();
          }}
          placeholder={
            asrSupported
              ? 'Type a message… or hold the mic to talk'
              : 'Type a message… (voice input needs Chrome/Edge)'
          }
        />
        <button className="btn primary" onClick={submitDraft} disabled={!draft.trim()}>
          Send
        </button>
        {asrSupported && (
          <button
            className={`btn mic ${micState === 'listening' ? 'listening' : ''}`}
            onPointerDown={handleMicPress}
            title="hold to talk (en-US)"
          >
            {micState === 'listening' ? 'STOP' : 'TALK'}
          </button>
        )}
      </div>

      {!joined && (
        <div className="overlay">
          <div className="spinner" />
          <p>{conn === 'offline' ? 'Server unreachable… retrying' : 'Joining room…'}</p>
        </div>
      )}

      {errorMsg && (
        <div className="error-toast">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}
    </div>
  );
}
