import { useState } from 'react';
import type { UserSettings } from '../types';

interface Props {
  settings: Partial<UserSettings>;
  onSave: (s: Partial<UserSettings>) => void;
}

export function KeyGate({ settings, onSave }: Props) {
  const [apiKey, setApiKey] = useState(settings.apiKey ?? '');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || 'https://api.deepseek.com');
  const [model, setModel] = useState(settings.model || 'deepseek-chat');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('Please paste your API key first.');
      return;
    }
    onSave({
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim() || undefined,
    });
  };

  return (
    <div className="center-screen">
      <form className="panel key-panel" onSubmit={submit}>
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <h1>English Chat Room</h1>
            <p className="muted">几个 AI 朋友在房间里用英语聊天，你随时可以插嘴。沉浸式听说环境。</p>
          </div>
        </div>

        <label className="field">
          <span>DeepSeek API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            autoFocus
          />
        </label>

        <button
          type="button"
          className="link"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? 'Hide advanced options' : 'Advanced options (base URL / model)'}
        </button>

        {showAdvanced && (
          <div className="advanced-grid">
            <label className="field">
              <span>Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
            <label className="field">
              <span>Model</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <button className="btn primary wide" type="submit" disabled={!apiKey.trim()}>
          Continue
        </button>

        <p className="hint">
          Key 只保存在你本机浏览器里，用于向 DeepSeek 发请求，不会上传到任何服务器存储。
        </p>
      </form>
    </div>
  );
}
