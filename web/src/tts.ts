// Browser speech synthesis (TTS) — free English voices built into the browser.
// Best quality is available in Microsoft Edge / Chrome on desktop Windows/macOS.

const FEMALE_MARKERS =
  /female|woman|girl|samantha|victoria|karen|moira|susan|zira|jenny|aria|ava|emma|sonia|tessa|allison|zoe|natasha|anna|siri|libby|kate|serena|veena/i;
const MALE_MARKERS =
  /male|man|boy|david|alex|daniel|mark|thomas|guy|fred|oliver|george|james|james|rishi|ryan|noah|ethan|andrew|eric/i;

let voices: SpeechSynthesisVoice[] = [];

function refreshVoices(): void {
  if ('speechSynthesis' in window) {
    voices = window.speechSynthesis.getVoices();
  }
}

if ('speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function englishVoices(): SpeechSynthesisVoice[] {
  return voices.filter((v) => v.lang?.toLowerCase().startsWith('en'));
}

function scoreVoice(v: SpeechSynthesisVoice, gender: 'm' | 'f'): number {
  const lang = v.lang.toLowerCase();
  const name = `${v.name} ${v.lang}`;
  const genderMatch = gender === 'f' ? FEMALE_MARKERS.test(name) : MALE_MARKERS.test(name);
  let s = 0;
  if (genderMatch) s += 40;
  if (lang.startsWith('en-us')) s += 30;
  else if (lang.startsWith('en-gb')) s += 25;
  else if (lang.startsWith('en')) s += 20;
  if (/online|natural|premium/i.test(v.name)) s += 15;
  if (/google/i.test(v.name)) s += 8;
  if (!v.localService) s += 2;
  return s;
}

export function pickVoice(gender: 'm' | 'f'): SpeechSynthesisVoice | null {
  const en = englishVoices();
  if (en.length === 0) return null;
  const sorted = [...en].sort((a, b) => scoreVoice(b, gender) - scoreVoice(a, gender));
  const best = sorted[0];
  return best && scoreVoice(best, gender) > 0 ? best : null;
}

export function hasEnglishVoice(): boolean {
  return englishVoices().length > 0;
}

function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const out: string[] = [];
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    // Long sentences get split so the browser never cuts them off.
    while (part.length > 170) {
      let cut = part.lastIndexOf('. ', 170);
      if (cut < 80) cut = part.lastIndexOf(', ', 170);
      if (cut < 80) cut = 170;
      const head = part.slice(0, cut + 1).trim();
      if (head) out.push(head);
      part = part.slice(cut + 1).trim();
    }
    if (part) out.push(part);
  }
  return out;
}

interface Line {
  id: string;
  gender: 'm' | 'f';
  text: string;
}

class Speaker {
  private muted = false;
  private queue: Line[] = [];
  private playing = false;
  private generation = 0; // bumped on stop() to invalidate in-flight chains
  private voiceCache = new Map<'m' | 'f', SpeechSynthesisVoice | null>();
  private maxQueue = 4;
  private onLineDone: ((id: string) => void) | null = null;

  isMuted(): boolean {
    return this.muted;
  }

  /** Hook the UI uses to ack the server once a message has been read aloud. */
  setOnLineDone(cb: ((id: string) => void) | null): void {
    this.onLineDone = cb;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m) this.clearQueue();
  }

  /** Cancel current speech and clear anything waiting (used when the human talks). */
  stop(): void {
    this.clearQueue();
  }

  private clearQueue(): void {
    this.generation++;
    this.queue = [];
    this.playing = false;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  /** Queue a line so that each person fully finishes speaking before the next starts. */
  speak(id: string, gender: 'm' | 'f', text: string): void {
    if (!ttsSupported() || this.muted) {
      // Nothing will be read (voice off / unsupported): ack immediately so the
      // server falls back to ordinary pacing instead of waiting on us forever.
      this.onLineDone?.(id);
      return;
    }
    this.queue.push({ id, gender, text });
    // If speech ever falls far behind the subtitles, skip the oldest unplayed line.
    if (this.queue.length > this.maxQueue) this.queue.shift();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.playing || this.muted) return;
    const item = this.queue.shift();
    if (!item) return;
    this.playing = true;
    try {
      await this.readLine(item);
    } catch {
      /* ignore */
    } finally {
      this.playing = false;
      this.onLineDone?.(item.id);
      if (!this.muted && this.queue.length > 0) void this.pump();
    }
  }

  private readLine(item: Line): Promise<void> {
    return new Promise((resolve) => {
      if (!this.voiceCache.has(item.gender)) {
        this.voiceCache.set(item.gender, pickVoice(item.gender));
      }
      const voice = this.voiceCache.get(item.gender);
      if (!voice) {
        resolve();
        return;
      }
      const gen = this.generation;
      const synth = window.speechSynthesis;
      const sentences = splitSentences(item.text);
      let index = 0;

      const sayNext = () => {
        if (gen !== this.generation) {
          resolve();
          return;
        }
        const sentence = sentences[index];
        index++;
        if (!sentence) {
          resolve();
          return;
        }
        const u = new SpeechSynthesisUtterance(sentence);
        u.voice = voice;
        u.rate = 1.02;
        u.pitch = item.gender === 'f' ? 1.08 : 0.94;
        u.volume = 1;
        u.onend = () => sayNext();
        u.onerror = () => sayNext();
        synth.speak(u);
      };
      sayNext();
    });
  }
}

export const speaker = new Speaker();
