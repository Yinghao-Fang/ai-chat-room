import { useCallback, useEffect, useState } from 'react';
import type { Meta, UserSettings } from './types';
import { loadSettings, saveSettings } from './types';
import { KeyGate } from './screens/KeyGate';
import { Lobby } from './screens/Lobby';
import { Room } from './screens/Room';

type Screen = { name: 'key' } | { name: 'lobby' } | { name: 'room'; roomId: string };

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Partial<UserSettings>>(() => loadSettings());
  const [screen, setScreen] = useState<Screen | null>(null);

  const loadMeta = useCallback(() => {
    setMetaError(null);
    fetch('/api/meta')
      .then((r) => {
        if (!r.ok) throw new Error(`server responded ${r.status}`);
        return r.json() as Promise<Meta>;
      })
      .then((m) => {
        setMeta(m);
        setScreen((prev) => prev ?? (loadSettings().apiKey ? { name: 'lobby' } : { name: 'key' }));
      })
      .catch(() => setMetaError('Cannot reach the server. Is the backend running?'));
  }, []);

  useEffect(loadMeta, [loadMeta]);

  const handleSaveSettings = useCallback(
    (next: Partial<UserSettings>) => {
      saveSettings(next);
      setSettings(loadSettings());
      setScreen({ name: 'lobby' });
    },
    []
  );

  const handleEditSettings = useCallback(() => setScreen({ name: 'key' }), []);
  const handleOpenRoom = useCallback((roomId: string) => setScreen({ name: 'room', roomId }), []);
  const handleLeaveRoom = useCallback(() => setScreen({ name: 'lobby' }), []);

  if (!meta && !metaError) {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <p>Loading…</p>
      </div>
    );
  }

  if (metaError || !meta) {
    return (
      <div className="center-screen">
        <div className="panel error-panel">
          <h1>Cannot start</h1>
          <p>{metaError ?? 'Unknown error'}</p>
          <button className="btn primary" onClick={loadMeta}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  switch (screen?.name) {
    case 'room':
      return (
        <Room
          roomId={screen.roomId}
          meta={meta}
          settings={settings}
          onLeave={handleLeaveRoom}
        />
      );
    case 'key':
      return <KeyGate settings={settings} onSave={handleSaveSettings} />;
    case 'lobby':
    default:
      return (
        <Lobby
          meta={meta}
          settings={settings}
          onEditSettings={handleEditSettings}
          onOpenRoom={handleOpenRoom}
        />
      );
  }
}
