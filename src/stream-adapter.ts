import { resolvePcmChannelMatrix } from './pcm-format.js';
import { finite, integer, invariant } from './validation.js';

/**
 * Continuous endpoint stream adapters: sample-rate conversion with carried
 * filter history, explicit channel mapping and bounded drift correction.
 *
 * These run at an authorized endpoint on plaintext PCM that is already
 * authorized for output (after decryption, before a native/browser sink) or on
 * locally captured PCM before encryption. They never run at a relay, never
 * change playback authority and never claim physical synchronization.
 */
export interface StreamResamplerConfig {
  inputRate: number;
  outputRate: number;
  channels: number;
  /** Maximum absolute drift correction accepted by setDriftCorrectionPpm. Default 1000, ceiling 5000. */
  maxDriftPpm?: number;
  /** Maximum change of drift correction per push call. Default 50 ppm, ceiling maxDriftPpm. */
  maxDriftSlewPpm?: number;
  /** Input frames accepted per push. Default 16384, ceiling 262144. Bounds callback work. */
  maxPushFrames?: number;
  /** Uniform pre-filter gain in (0, 1]. Default 1. Reserve headroom for filter overshoot. */
  headroom?: number;
}
export interface StreamResamplerState {
  inputFramesAccepted: number;
  outputFramesProduced: number;
  /** Requested, slew-limited correction currently applied, in parts per million. */
  driftCorrectionPpm: number;
  /** Input frames consumed per output frame, including drift correction. */
  effectiveStep: number;
  /** Fixed algorithmic delay, in input frames. */
  latencyInputFrames: number;
  /** Output samples clamped to [-1, 1] after filter overshoot. Never silently hidden. */
  clippedSamples: number;
  flushed: boolean;
  algorithm: 'blackman-windowed-sinc-stream-v1';
  realtimeQualified: false;
}

const PHASES = 512;
const MAX_PUSH_FRAMES = 262144;
function snapshotOptions(value: object, keys: string[], required: string[]): void {
  invariant(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'INVALID_STREAM_ADAPTER_CONFIG');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  invariant(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) &&
    required.every(key => Object.hasOwn(value, key)) && Object.values(descriptors).every(d => 'value' in d && d.enumerable),
    'INVALID_STREAM_ADAPTER_CONFIG');
}
function interleaved(input: Float32Array, channels: number, maxFrames: number): number {
  invariant(input instanceof Float32Array && input.buffer instanceof ArrayBuffer, 'INVALID_STREAM_PCM_BUFFER');
  invariant(input.length % channels === 0, 'INVALID_STREAM_PCM_SHAPE');
  const frames = input.length / channels;
  invariant(frames <= maxFrames, 'STREAM_PUSH_LIMIT');
  for (const sample of input) finite(sample, -1, 1);
  return frames;
}

/**
 * Streaming windowed-sinc resampler. Chunk boundaries do not change output:
 * pushing a signal in any split yields byte-identical results to one push,
 * because the filter history and fractional position are carried exactly and
 * the arithmetic sequence is independent of chunking. The stream starts from
 * silence (zero history) and flush() extends with silence, so leading and
 * trailing transients are explicit rather than invented from edge samples.
 */
export class StreamingResampler {
  readonly inputRate: number; readonly outputRate: number; readonly channels: number;
  readonly maxDriftPpm: number; readonly maxDriftSlewPpm: number; readonly maxPushFrames: number;
  readonly headroom: number;
  readonly #radius: number; readonly #taps: number; readonly #table: Float64Array; readonly #nominalStep: number;
  #history: Float32Array; #historyFrames: number;
  /** Absolute input position of #history[0]. */
  #historyBase = 0;
  /** Absolute integer input frame and fractional offset of the next output. */
  #positionFrame = 0; #positionFraction = 0;
  #requestedPpm = 0; #appliedPpm = 0;
  #inputFrames = 0; #outputFrames = 0; #clipped = 0; #flushed = false;

  constructor(config: StreamResamplerConfig) {
    snapshotOptions(config, ['inputRate', 'outputRate', 'channels', 'maxDriftPpm', 'maxDriftSlewPpm', 'maxPushFrames', 'headroom'],
      ['inputRate', 'outputRate', 'channels']);
    const { inputRate, outputRate, channels } = config;
    integer(inputRate, 8000, 192000); integer(outputRate, 8000, 192000); integer(channels, 1, 8);
    const maxDriftPpm = config.maxDriftPpm ?? 1000; finite(maxDriftPpm, 0, 5000);
    const maxDriftSlewPpm = config.maxDriftSlewPpm ?? Math.min(50, maxDriftPpm); finite(maxDriftSlewPpm, 0, maxDriftPpm);
    const maxPushFrames = config.maxPushFrames ?? 16384; integer(maxPushFrames, 1, MAX_PUSH_FRAMES);
    const headroom = config.headroom ?? 1; finite(headroom, Number.MIN_VALUE, 1);
    invariant(headroom > 0, 'INVALID_NUMBER');
    Object.assign(this, { inputRate, outputRate, channels, maxDriftPpm, maxDriftSlewPpm, maxPushFrames, headroom });
    this.inputRate = inputRate; this.outputRate = outputRate; this.channels = channels;
    this.maxDriftPpm = maxDriftPpm; this.maxDriftSlewPpm = maxDriftSlewPpm; this.maxPushFrames = maxPushFrames; this.headroom = headroom;
    this.#nominalStep = inputRate / outputRate;
    // Leave margin for the largest drift so the anti-alias cutoff stays below output Nyquist.
    const cutoff = 0.9 * Math.min(1, outputRate / (inputRate * (1 + maxDriftPpm * 1e-6)));
    const radius = Math.ceil(32 / cutoff), taps = 2 * radius;
    this.#radius = radius; this.#taps = taps;
    // Row p holds the kernel for fractional offset p/PHASES; rows 0..PHASES inclusive
    // allow linear interpolation between neighbouring phases. Each row is unit-sum
    // normalized so a constant signal is preserved at every fractional position.
    const table = new Float64Array((PHASES + 1) * taps);
    for (let phase = 0; phase <= PHASES; phase++) {
      const fraction = phase / PHASES; let sum = 0;
      for (let index = 0; index < taps; index++) {
        // Tap index maps to input frame (floor(position) - radius + 1 + index).
        const x = index - radius + 1 - fraction;
        const argument = Math.PI * cutoff * x;
        const sinc = argument === 0 ? 1 : Math.sin(argument) / argument;
        const window = Math.abs(x) >= radius ? 0 :
          0.42 + 0.5 * Math.cos(Math.PI * x / radius) + 0.08 * Math.cos(2 * Math.PI * x / radius);
        const value = sinc * window; table[phase * taps + index] = value; sum += value;
      }
      invariant(Number.isFinite(sum) && sum > 0.5, 'STREAM_FILTER_NORMALIZATION_FAILED');
      for (let index = 0; index < taps; index++) table[phase * taps + index] = table[phase * taps + index]! / sum;
    }
    this.#table = table;
    // Zero history: the stream begins from silence at absolute input frame 0.
    this.#history = new Float32Array((taps + maxPushFrames + radius) * channels);
    this.#historyBase = -(radius - 1);
    this.#historyFrames = radius - 1;
  }

  /** Request a drift correction. Positive ppm consumes input faster (the sink is
   * draining slower than the nominal ratio implies). Applied gradually on push. */
  setDriftCorrectionPpm(ppm: number): void {
    finite(ppm, -this.maxDriftPpm, this.maxDriftPpm);
    this.#requestedPpm = ppm;
  }

  get state(): Readonly<StreamResamplerState> {
    return Object.freeze({
      inputFramesAccepted: this.#inputFrames, outputFramesProduced: this.#outputFrames,
      driftCorrectionPpm: this.#appliedPpm, effectiveStep: this.#step(),
      latencyInputFrames: this.#radius, clippedSamples: this.#clipped, flushed: this.#flushed,
      algorithm: 'blackman-windowed-sinc-stream-v1', realtimeQualified: false,
    });
  }

  /** Accept interleaved PCM and return every output frame now fully determined. */
  push(input: Float32Array): Float32Array {
    invariant(!this.#flushed, 'STREAM_ALREADY_FLUSHED');
    const frames = interleaved(input, this.channels, this.maxPushFrames);
    const delta = this.#requestedPpm - this.#appliedPpm;
    this.#appliedPpm += Math.max(-this.maxDriftSlewPpm, Math.min(this.maxDriftSlewPpm, delta));
    this.#append(input, frames);
    this.#inputFrames += frames;
    return this.#render(this.#inputFrames);
  }

  /** End of stream: extend with silence and emit the remaining output frames
   * whose source position lies inside the accepted input. */
  flush(): Float32Array {
    invariant(!this.#flushed, 'STREAM_ALREADY_FLUSHED');
    this.#flushed = true;
    this.#append(new Float32Array(this.#radius * this.channels), this.#radius);
    return this.#render(this.#inputFrames, true);
  }

  #step(): number { return this.#nominalStep * (1 + this.#appliedPpm * 1e-6); }

  #append(input: Float32Array, frames: number): void {
    const channels = this.channels;
    // Discard history that can no longer contribute to any future output.
    const keepFrom = this.#positionFrame - this.#radius + 1;
    const drop = Math.max(0, Math.min(this.#historyFrames, keepFrom - this.#historyBase));
    if (drop > 0) {
      this.#history.copyWithin(0, drop * channels, this.#historyFrames * channels);
      this.#historyFrames -= drop; this.#historyBase += drop;
    }
    const needed = (this.#historyFrames + frames) * channels;
    if (needed > this.#history.length) {
      const grown = new Float32Array(needed); grown.set(this.#history.subarray(0, this.#historyFrames * channels)); this.#history = grown;
    }
    const scale = this.headroom;
    const offset = this.#historyFrames * channels;
    if (scale === 1) this.#history.set(input, offset);
    else for (let i = 0; i < input.length; i++) this.#history[offset + i] = input[i]! * scale;
    this.#historyFrames += frames;
  }

  #render(limitFrames: number, final = false): Float32Array {
    const channels = this.channels, taps = this.#taps, radius = this.#radius, table = this.#table;
    const available = this.#historyBase + this.#historyFrames;
    const step = this.#step();
    const integral = Math.floor(step), fractional = step - integral;
    const out: number[] = [];
    const accumulators = new Float64Array(channels);
    while (true) {
      const frame = this.#positionFrame;
      // Real input must cover the output's position; the full window must be buffered.
      if (final ? frame >= limitFrames : false) break;
      if (frame + radius >= available) break;
      const scaled = this.#positionFraction * PHASES;
      const phase = Math.min(PHASES - 1, Math.floor(scaled));
      const blend = scaled - phase;
      const rowA = phase * taps, rowB = rowA + taps;
      accumulators.fill(0);
      const start = (frame - radius + 1 - this.#historyBase) * channels;
      for (let index = 0; index < taps; index++) {
        const coefficient = table[rowA + index]! + blend * (table[rowB + index]! - table[rowA + index]!);
        const base = start + index * channels;
        for (let channel = 0; channel < channels; channel++) accumulators[channel]! += coefficient * this.#history[base + channel]!;
      }
      for (let channel = 0; channel < channels; channel++) {
        let value = accumulators[channel]!;
        if (value > 1) { value = 1; this.#clipped++; } else if (value < -1) { value = -1; this.#clipped++; }
        out.push(value);
      }
      this.#outputFrames++;
      // Exact carry: integer and fractional parts advance separately, so the
      // sequence of floating-point operations never depends on chunking.
      let nextFraction = this.#positionFraction + fractional, nextFrame = frame + integral;
      if (nextFraction >= 1) { nextFraction -= 1; nextFrame += 1; }
      this.#positionFrame = nextFrame; this.#positionFraction = nextFraction;
    }
    return Float32Array.from(out);
  }
}

/** Streaming channel mapping with the same explicit policy as convertPcmFormat:
 * identity, mono->stereo duplicate, stereo->mono average, or a supplied matrix
 * whose rows have an absolute sum <= 1. No speaker semantics are inferred. */
export class StreamingChannelMapper {
  readonly inputChannels: number; readonly outputChannels: number;
  readonly #matrix: readonly (readonly number[])[];
  constructor(inputChannels: number, outputChannels: number, channelMatrix?: readonly (readonly number[])[]) {
    integer(inputChannels, 1, 8); integer(outputChannels, 1, 8);
    const matrix = resolvePcmChannelMatrix(inputChannels, channelMatrix === undefined
      ? { sampleRate: 8000, channels: outputChannels } : { sampleRate: 8000, channels: outputChannels, channelMatrix });
    this.inputChannels = inputChannels; this.outputChannels = outputChannels;
    this.#matrix = Object.freeze(matrix.map(row => Object.freeze([...row])));
  }
  map(input: Float32Array): Float32Array {
    const frames = interleaved(input, this.inputChannels, MAX_PUSH_FRAMES);
    const output = new Float32Array(frames * this.outputChannels);
    for (let frame = 0; frame < frames; frame++) for (let out = 0; out < this.outputChannels; out++) {
      const row = this.#matrix[out]!; let sum = 0;
      for (let source = 0; source < this.inputChannels; source++) sum += row[source]! * input[frame * this.inputChannels + source]!;
      output[frame * this.outputChannels + out] = sum;
    }
    return output;
  }
}

export interface DriftControllerConfig {
  /** Target sink queue fill in frames. */
  targetFillFrames: number;
  /** Proportional gain, ppm per frame of error. Default 0.5. */
  proportionalPpmPerFrame?: number;
  /** Integral gain, ppm per frame-second of error. Default 0.05. */
  integralPpmPerFrameSecond?: number;
  /** Output clamp. Default 500 ppm, ceiling 5000. */
  maxPpm?: number;
  /** Observations older than this relative to the previous one reset the controller. Default 2000 ms. */
  maxObservationGapMs?: number;
  /** Absolute fill error at which the controller stops and requests a resynchronizing rejoin. */
  resyncErrorFrames: number;
}
export type DriftDecision =
  | { state: 'tracking'; correctionPpm: number; errorFrames: number }
  | { state: 'warming'; correctionPpm: 0 }
  | { state: 'resync-required'; correctionPpm: 0; reason: 'FILL_ERROR_EXCEEDED' | 'OBSERVATION_GAP' | 'NON_MONOTONIC_OBSERVATION' };

/**
 * Converts sink queue-fill observations into a bounded drift correction for
 * StreamingResampler. It corrects only small, slow rate mismatch; large errors,
 * gaps or time reversal fail closed to an explicit resync (stop and rejoin),
 * never to skipping, stretching or silently continuing.
 */
export class DriftController {
  readonly #target: number; readonly #kp: number; readonly #ki: number; readonly #max: number;
  readonly #gap: number; readonly #resync: number;
  #lastMs: number | undefined; #integral = 0; #failed = false;
  constructor(config: DriftControllerConfig) {
    snapshotOptions(config, ['targetFillFrames', 'proportionalPpmPerFrame', 'integralPpmPerFrameSecond', 'maxPpm',
      'maxObservationGapMs', 'resyncErrorFrames'], ['targetFillFrames', 'resyncErrorFrames']);
    integer(config.targetFillFrames, 1, 10_000_000); integer(config.resyncErrorFrames, 1, 10_000_000);
    const kp = config.proportionalPpmPerFrame ?? 0.5, ki = config.integralPpmPerFrameSecond ?? 0.05;
    const max = config.maxPpm ?? 500, gap = config.maxObservationGapMs ?? 2000;
    finite(kp, 0, 1000); finite(ki, 0, 1000); finite(max, 0, 5000); finite(gap, 1, 600000);
    this.#target = config.targetFillFrames; this.#kp = kp; this.#ki = ki; this.#max = max; this.#gap = gap;
    this.#resync = config.resyncErrorFrames;
  }
  /** Observe the sink queue fill at a monotonic time (ms). */
  observe(fillFrames: number, monotonicMs: number): DriftDecision {
    integer(fillFrames, 0, 100_000_000); finite(monotonicMs, 0);
    if (this.#failed) return { state: 'resync-required', correctionPpm: 0, reason: 'FILL_ERROR_EXCEEDED' };
    const previous = this.#lastMs;
    if (previous !== undefined && monotonicMs <= previous) return this.#fail('NON_MONOTONIC_OBSERVATION');
    if (previous !== undefined && monotonicMs - previous > this.#gap) return this.#fail('OBSERVATION_GAP');
    this.#lastMs = monotonicMs;
    const error = fillFrames - this.#target;
    if (Math.abs(error) > this.#resync) return this.#fail('FILL_ERROR_EXCEEDED');
    if (previous === undefined) return { state: 'warming', correctionPpm: 0 };
    const seconds = (monotonicMs - previous) / 1000;
    // Anti-windup: integral alone may not exceed the output clamp.
    const limit = this.#ki === 0 ? 0 : this.#max / this.#ki;
    this.#integral = Math.max(-limit, Math.min(limit, this.#integral + error * seconds));
    const raw = this.#kp * error + this.#ki * this.#integral;
    // More queued frames than target: the sink is slower; consume input faster.
    const correctionPpm = Math.max(-this.#max, Math.min(this.#max, raw));
    return { state: 'tracking', correctionPpm, errorFrames: error };
  }
  /** Explicit reset after a fresh join. */
  reset(): void { this.#lastMs = undefined; this.#integral = 0; this.#failed = false; }
  #fail(reason: 'FILL_ERROR_EXCEEDED' | 'OBSERVATION_GAP' | 'NON_MONOTONIC_OBSERVATION'): DriftDecision {
    this.#failed = true; this.#integral = 0;
    return { state: 'resync-required', correctionPpm: 0, reason };
  }
}
