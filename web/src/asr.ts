// Web Speech API speech recognition (ASR) — push-to-talk English input.
// Requires Chrome / Edge (webkitSpeechRecognition).

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

const SR: RecognitionCtor | null =
  (typeof window !== 'undefined' &&
    ((window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as
      RecognitionCtor | undefined) ||
  null;

export const asrSupported = SR !== null;

export interface AsrEvents {
  onResult: (finalText: string, interim: string) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

export class MicRecorder {
  private rec: SpeechRecognitionLike | null = null;
  private finalText = '';
  private started = false;

  start(lang: string, events: AsrEvents): boolean {
    if (!SR) {
      events.onError('Speech recognition is not supported in this browser. Try Chrome or Edge.');
      return false;
    }
    this.stop();
    const rec = new SR();
    rec.lang = lang || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      events.onResult(this.finalText.trim(), interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      events.onError(e.error);
    };
    rec.onend = () => {
      this.rec = null;
      this.started = false;
      events.onEnd();
    };

    try {
      rec.start();
    } catch {
      events.onError('Could not start the microphone.');
      return false;
    }
    this.rec = rec;
    this.started = true;
    this.finalText = '';
    return true;
  }

  stop(): void {
    if (this.rec) {
      try {
        this.rec.stop();
      } catch {
        /* ignore */
      }
    }
  }

  abort(): void {
    if (this.rec) {
      try {
        this.rec.abort();
      } catch {
        /* ignore */
      }
      this.rec = null;
    }
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }
}
