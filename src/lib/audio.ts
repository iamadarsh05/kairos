// Browser audio helpers for the Gemini Live API.
//
// Live API contract:
//   - INPUT  (mic → model): raw 16-bit PCM, 16 kHz, mono, little-endian, base64.
//   - OUTPUT (model → us):  raw 16-bit PCM, 24 kHz, mono, little-endian, base64.
//
// We capture mic audio with an AudioWorklet (preferred) or ScriptProcessor
// (fallback), downsample to 16 kHz, and stream PCM chunks up. Output chunks are
// queued and played back gaplessly through a 24 kHz AudioContext.

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

/** Float32 [-1,1] → 16-bit PCM little-endian bytes. */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, s, true); // little-endian
  }
  return buffer;
}

/** Simple linear-interpolation resampler to the target rate. */
export function downsample(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (toRate === fromRate) return input;
  const ratio = fromRate / toRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const idx = i * ratio;
    const low = Math.floor(idx);
    const high = Math.min(low + 1, input.length - 1);
    const frac = idx - low;
    result[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return result;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Plays a sequence of 24 kHz PCM chunks back-to-back without gaps. Each pushed
 * chunk is scheduled to start exactly when the previous one ends.
 */
export class PCMPlayer {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private analyser: AnalyserNode;
  private levelBuf: Uint8Array<ArrayBuffer>;

  constructor(sampleRate = OUTPUT_SAMPLE_RATE) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx({ sampleRate });
    // Analyser taps the output so we can read the agent's live speaking level.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;
    this.analyser.connect(this.ctx.destination);
    this.levelBuf = new Uint8Array(
      new ArrayBuffer(this.analyser.frequencyBinCount)
    );
  }

  /** Current output loudness, ~0..1 (RMS of the waveform being played). */
  getLevel(): number {
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const d = (this.levelBuf[i] - 128) / 128;
      sum += d * d;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 2.4);
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Enqueue one base64 PCM16 chunk for gapless playback. */
  play(base64Pcm: string) {
    const buffer = base64ToArrayBuffer(base64Pcm);
    const view = new DataView(buffer);
    const frameCount = buffer.byteLength / 2;
    const audioBuffer = this.ctx.createBuffer(
      1,
      frameCount,
      this.ctx.sampleRate
    );
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;

    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((s) => s !== source);
    };
  }

  /** Stop everything immediately (used on barge-in / interruption). */
  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.nextStartTime = 0;
  }

  close() {
    this.stop();
    void this.ctx.close();
  }
}

/**
 * Captures microphone audio, downsamples to 16 kHz PCM16, and emits base64
 * chunks via the onChunk callback. Uses ScriptProcessor for maximum browser
 * compatibility (an AudioWorklet would need a separate module file).
 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _level = 0;
  private muted = false;

  constructor(private onChunk: (base64Pcm: string) => void) {}

  /** Current mic input loudness, ~0..1. */
  getLevel(): number {
    return this._level;
  }

  /** Mute/unmute: when muted, no audio is sent to the model. */
  setMuted(muted: boolean) {
    this.muted = muted;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();
    const inputRate = this.ctx.sampleRate; // typically 44100 or 48000

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      // When muted, send nothing and report zero level (button won't react).
      if (this.muted) {
        this._level = 0;
        return;
      }
      const input = e.inputBuffer.getChannelData(0);
      // Track input loudness (RMS) for the reactive visualizer.
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      this._level = Math.min(1, Math.sqrt(sum / input.length) * 6);

      const down = downsample(input, inputRate, INPUT_SAMPLE_RATE);
      const pcm = floatTo16BitPCM(down);
      this.onChunk(arrayBufferToBase64(pcm));
    };

    this.source.connect(this.processor);
    // Connect to destination so the processor fires; gain 0 avoids echo of mic.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
  }

  stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}
