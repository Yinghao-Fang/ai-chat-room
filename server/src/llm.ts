// Minimal OpenAI-compatible chat completion client with SSE streaming.
// Default endpoint is DeepSeek (https://api.deepseek.com, model deepseek-chat).

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';

export interface LLMCredentials {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class LLMError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function* streamChat(
  creds: LLMCredentials,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): AsyncGenerator<string> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = creds.model || DEFAULT_MODEL;
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 400,
    }),
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new LLMError(res.status, `LLM request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = -1;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) yield delta;
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  } finally {
    controller.abort();
  }
}

export async function chatOnce(
  creds: LLMCredentials,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  let out = '';
  for await (const chunk of streamChat(creds, system, user, opts)) {
    out += chunk;
  }
  return out.trim();
}
