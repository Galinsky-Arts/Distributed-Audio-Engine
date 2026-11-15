import type { PcmAudio } from './media.js';
import type { PcmPlaybackSink } from './player.js';
import { DriftController, StreamingChannelMapper, StreamingResampler } from './stream-adapter.js';
import type { DriftControllerConfig, DriftDecision } from './stream-adapter.js';
import { finite, identifier, integer, invariant } from './validation.js';

/** Format the wrapped sink currently accepts (native sinks require exact equality). */
export interface SinkOutputFormat { sampleRate: number; channels: number }
export interface PlaybackStreamAdapterOptions {
  /** Explicit channel policy when asset and output channel counts differ (see convertPcmFormat). */
  channelMatrix?: readonly (readonly number[])[];
  /** Uniform pre-filter gain in (0, 1]. Default 1. Overshoot is clamped and counted, never hidden. */
  headroom?: number;
  maxDriftPpm?: number;
  maxDriftSlewPpm?: number;
  /** Enables queue-fill drift correction. Drift correction always uses the resampling path. */
  drift?: DriftControllerConfig;
  /** Nominal schedule time may diverge from timeline time by at most this much (ms). Default 25, ceiling 250. */
  maxScheduleSkewMs?: number;
}
export interface PlaybackStreamAdapterState {
  mode: 'idle' | 'passthrough' | 'adapting';
  inputRate: number | null; outputRate: number | null;
  inputChannels: number | null; outputChannels: number | null;
  driftCorrectionPpm: number; clippedSamples: number;
  /** Fixed added output delay (ms) of the adapting path; 0 when passing through. */
  latencyMs: number;
  /** Nominal sink schedule minus timeline position of the same audio (ms). */
  scheduleSkewMs: number;
  realtimeQualified: false;
}
/** Reserved below the inner sink horizon for the worst-case filter delay. */
export const STREAM_ADAPTER_HORIZON_RESERVE_MS = 6;

interface Stream {
  inRate: number; inChannels: number; outRate: number; outChannels: number;
  resampler: StreamingResampler; mapper: StreamingChannelMapper | undefined;
  originMs: number; latencyMs: number;
  inputFrames: number; outputFrames: number; representedInputFrames: number;
  /** Exact end returned by the inner sink for the previous output, so voices never overlap by rounding. */
  nextOutputMs: number | undefined;
}

/**
 * Wraps an exact-format endpoint sink (Android/iOS/browser) for EndpointProgramPlayer.
 * Decrypted, currently authorized PCM is converted with the continuous stream
 * adapters only at this endpoint, immediately before the native sink. Contiguous
 * schedules (the player's normal linear progression, including clip boundaries)
 * are one continuous resampler stream, so chunking never changes output. A
 * discontinuity, format change or stopAll starts a fresh stream from silence.
 *
 * It never grants or extends authority: the wrapped sink still applies its
 * envelope, deadline, queue and route checks to every converted block.
 */
export class AdaptingPcmSink implements PcmPlaybackSink {
  readonly horizonMs: number;
  readonly #inner: PcmPlaybackSink;
  readonly #format: () => SinkOutputFormat | undefined;
  readonly #options: PlaybackStreamAdapterOptions;
  readonly #drift: DriftController | undefined;
  readonly #maxSkewMs: number;
  #stream: Stream | undefined;
  #mode: 'idle' | 'passthrough' | 'adapting' = 'idle';
  #clipped = 0;
  #requestedPpm = 0;

  constructor(inner: PcmPlaybackSink, format: () => SinkOutputFormat | undefined, options: PlaybackStreamAdapterOptions = {}) {
    invariant(options && typeof options === 'object' && !Array.isArray(options), 'INVALID_STREAM_ADAPTER_CONFIG');
    for (const key of Object.keys(options)) invariant(['channelMatrix', 'headroom', 'maxDriftPpm', 'maxDriftSlewPpm', 'drift', 'maxScheduleSkewMs'].includes(key), 'INVALID_STREAM_ADAPTER_CONFIG');
    integer(inner.horizonMs, STREAM_ADAPTER_HORIZON_RESERVE_MS + 2, 5000);
    this.#maxSkewMs = options.maxScheduleSkewMs ?? 25; finite(this.#maxSkewMs, 1, 250);
    this.#inner = inner; this.#format = format;
    this.#options = Object.freeze({ ...options, ...(options.channelMatrix ? { channelMatrix: options.channelMatrix.map(row => [...row]) } : {}) });
    this.#drift = options.drift ? new DriftController({ ...options.drift }) : undefined;
    // Validate resampler options eagerly so a misconfiguration fails at construction.
    if (options.headroom !== undefined || options.maxDriftPpm !== undefined || options.maxDriftSlewPpm !== undefined)
      this.#resampler(48000, 44100, 1);
    this.horizonMs = inner.horizonMs - STREAM_ADAPTER_HORIZON_RESERVE_MS;
  }

  get state(): Readonly<PlaybackStreamAdapterState> {
    const stream = this.#stream;
    const resampled = stream?.resampler.state;
    return Object.freeze({
      mode: this.#mode,
      inputRate: stream?.inRate ?? null, outputRate: stream?.outRate ?? null,
      inputChannels: stream?.inChannels ?? null, outputChannels: stream?.outChannels ?? null,
      driftCorrectionPpm: resampled?.driftCorrectionPpm ?? 0,
      clippedSamples: this.#clipped + (resampled?.clippedSamples ?? 0),
      latencyMs: stream?.latencyMs ?? 0,
      scheduleSkewMs: stream ? this.#skew(stream) : 0,
      realtimeQualified: false,
    });
  }

  schedule(id: string, audio: PcmAudio, targetUnixMs: number, offsetFrames = 0, requestedFrames = audio.samples.length / audio.channels - offsetFrames) {
    identifier(id);
    const format = this.#format();
    invariant(format, 'ADAPTED_OUTPUT_UNAVAILABLE');
    integer(format.sampleRate, 8000, 192000); integer(format.channels, 1, 8);
    integer(audio.sampleRate, 8000, 192000); integer(audio.channels, 1, 8);
    invariant(audio.samples instanceof Float32Array && audio.samples.length % audio.channels === 0, 'INVALID_PCM_SHAPE');
    const totalFrames = audio.samples.length / audio.channels;
    integer(offsetFrames, 0, totalFrames - 1); integer(requestedFrames, 1, totalFrames - offsetFrames);
    finite(targetUnixMs, 0);
    if (!this.#drift && format.sampleRate === audio.sampleRate && format.channels === audio.channels) {
      this.#reset(); this.#mode = 'passthrough';
      return this.#inner.schedule(id, audio, targetUnixMs, offsetFrames, requestedFrames);
    }
    let stream = this.#stream;
    if (!stream || stream.inRate !== audio.sampleRate || stream.inChannels !== audio.channels ||
        stream.outRate !== format.sampleRate || stream.outChannels !== format.channels ||
        Math.abs(targetUnixMs - this.#inputTimeMs(stream)) > 500 / audio.sampleRate) {
      this.#reset();
      stream = this.#open(audio.sampleRate, audio.channels, format, targetUnixMs);
    }
    this.#mode = 'adapting';
    const slice = audio.samples.subarray(offsetFrames * audio.channels, (offsetFrames + requestedFrames) * audio.channels);
    let mapped: Float32Array | undefined;
    const blocks: Float32Array[] = [];
    let output: Float32Array | undefined;
    try {
      mapped = stream.mapper ? stream.mapper.map(slice) : slice;
      const chunk = stream.resampler.maxPushFrames * stream.outChannels;
      for (let start = 0; start < mapped.length; start += chunk) blocks.push(stream.resampler.push(mapped.subarray(start, start + chunk)));
      const samples = blocks.reduce((sum, block) => sum + block.length, 0);
      const outFrames = samples / stream.outChannels;
      const step = stream.resampler.state.effectiveStep;
      const startMs = stream.nextOutputMs ?? stream.originMs + stream.latencyMs;
      if (outFrames === 0) {
        // Entirely inside filter delay; carried to the next contiguous block.
        stream.inputFrames += requestedFrames;
        return { frames: requestedFrames, startsAtMs: targetUnixMs, endsAtMs: targetUnixMs + requestedFrames * 1000 / audio.sampleRate, alignment: 'timeline-only' as const };
      }
      output = new Float32Array(samples);
      let at = 0; for (const block of blocks) { output.set(block, at); at += block.length; }
      const result = this.#inner.schedule(id, { sampleRate: stream.outRate, channels: stream.outChannels, samples: output }, startMs, 0, outFrames);
      integer(result.frames, 1, outFrames);
      if (result.frames < outFrames) {
        // The inner sink clipped to its authority/horizon window. Report the input
        // frames covered (rounded up so the next stream cannot overlap) and restart.
        const coveredMs = result.endsAtMs - stream.originMs - stream.latencyMs;
        const coveredInput = Math.ceil(coveredMs * stream.inRate / 1000) - stream.inputFrames;
        const frames = Math.max(1, Math.min(requestedFrames, coveredInput));
        this.#reset();
        return { frames, startsAtMs: targetUnixMs, endsAtMs: targetUnixMs + frames * 1000 / audio.sampleRate, alignment: 'timeline-only' as const };
      }
      stream.inputFrames += requestedFrames; stream.outputFrames += outFrames;
      stream.representedInputFrames += outFrames * step;
      stream.nextOutputMs = result.endsAtMs;
      const skew = this.#skew(stream);
      if (Math.abs(skew) > this.#maxSkewMs) { this.stopAll(); throw new Error('STREAM_ADAPTER_SCHEDULE_SKEW'); }
      return { frames: requestedFrames, startsAtMs: targetUnixMs, endsAtMs: targetUnixMs + requestedFrames * 1000 / audio.sampleRate, alignment: 'timeline-only' as const };
    } catch (error) {
      if (this.#stream === stream) this.#reset();
      throw error;
    } finally {
      // Bound plaintext lifetime of adapter-owned copies; the inner sink copies what it queues.
      if (mapped && mapped !== slice) mapped.fill(0);
      for (const block of blocks) block.fill(0);
      output?.fill(0);
    }
  }

  /** Feed the sink's queued-frame count. Requires the `drift` option. A resync
   * decision stops all output; the caller must perform a fresh authenticated join. */
  observeQueueFill(fillFrames: number, monotonicMs: number): DriftDecision {
    invariant(this.#drift, 'STREAM_ADAPTER_DRIFT_DISABLED');
    const decision = this.#drift.observe(fillFrames, monotonicMs);
    if (decision.state === 'tracking') {
      const max = this.#options.maxDriftPpm ?? 1000;
      this.#requestedPpm = Math.max(-max, Math.min(max, decision.correctionPpm));
      this.#stream?.resampler.setDriftCorrectionPpm(this.#requestedPpm);
    } else if (decision.state === 'resync-required') this.stopAll();
    return decision;
  }

  stopAll(): void {
    this.#reset(); this.#drift?.reset(); this.#mode = 'idle'; this.#requestedPpm = 0;
    this.#inner.stopAll();
  }

  #inputTimeMs(stream: Stream): number { return stream.originMs + stream.inputFrames * 1000 / stream.inRate; }
  #skew(stream: Stream): number {
    return stream.outputFrames * 1000 / stream.outRate - stream.representedInputFrames * 1000 / stream.inRate;
  }
  #resampler(inputRate: number, outputRate: number, channels: number): StreamingResampler {
    const { headroom, maxDriftPpm, maxDriftSlewPpm } = this.#options;
    return new StreamingResampler({ inputRate, outputRate, channels,
      ...(headroom === undefined ? {} : { headroom }),
      ...(maxDriftPpm === undefined ? {} : { maxDriftPpm }),
      ...(maxDriftSlewPpm === undefined ? {} : { maxDriftSlewPpm }) });
  }
  #open(inRate: number, inChannels: number, format: SinkOutputFormat, originMs: number): Stream {
    const mapper = inChannels === format.channels ? undefined :
      new StreamingChannelMapper(inChannels, format.channels, this.#options.channelMatrix);
    const resampler = this.#resampler(inRate, format.sampleRate, format.channels);
    // The sink clock mismatch persists across a discontinuity; keep the requested correction (slew-limited).
    if (this.#requestedPpm !== 0) resampler.setDriftCorrectionPpm(this.#requestedPpm);
    // Delay the whole stream by the filter radius plus one frame on each side so
    // the first carried output never starts before the timeline target.
    const latencyMs = (resampler.state.latencyInputFrames + 1) * 1000 / inRate + 1000 / format.sampleRate;
    invariant(latencyMs < STREAM_ADAPTER_HORIZON_RESERVE_MS, 'STREAM_ADAPTER_LATENCY_EXCEEDED');
    this.#stream = { inRate, inChannels, outRate: format.sampleRate, outChannels: format.channels, resampler, mapper,
      originMs, latencyMs, inputFrames: 0, outputFrames: 0, representedInputFrames: 0, nextOutputMs: undefined };
    return this.#stream;
  }
  #reset(): void {
    const stream = this.#stream; this.#stream = undefined;
    if (stream) { this.#clipped += stream.resampler.state.clippedSamples; stream.resampler.dispose(); }
  }
}
