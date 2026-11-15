import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptingPcmSink, StreamingResampler, StreamingChannelMapper, STREAM_ADAPTER_HORIZON_RESERVE_MS,
  EndpointPlaybackSession, ControlVerifier, MemoryCheckpointStore, createControlSigningKey,
  signControl, packageRendition, ProgramTimeline, compileProgram,
} from '../src/index.js';
import type { AndroidAudioEvent, AndroidPcmRequest, LeasePolicy, PcmAudio, PcmPlaybackSink, PlaybackSessionOptions, PlaybackStreamAdapterOptions } from '../src/index.js';

interface Scheduled { id: string; samples: Float32Array; held: Float32Array; sampleRate: number; channels: number; target: number; frames: number }
function innerSink(limitFrames = Infinity) {
  const scheduled: Scheduled[] = []; let stops = 0;
  const sink: PcmPlaybackSink = {
    horizonMs: 2000,
    schedule(id, audio, target, offset, frames) {
      const accepted = Math.min(frames, limitFrames);
      // Like native sinks: copy the authorized slice; the caller's buffer is not retained.
      scheduled.push({ id, samples: audio.samples.slice(offset * audio.channels, (offset + accepted) * audio.channels), held: audio.samples,
        sampleRate: audio.sampleRate, channels: audio.channels, target, frames: accepted });
      return { frames: accepted, startsAtMs: target, endsAtMs: target + accepted * 1000 / audio.sampleRate, alignment: 'timeline-only' as const };
    },
    stopAll() { stops++; },
  };
  return { sink, scheduled, get stops() { return stops; } };
}
function tone(rate: number, channels: number, frames: number): PcmAudio {
  const samples = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) samples[f * channels + c] = 0.5 * Math.sin(2 * Math.PI * 440 * f / rate + c);
  return { sampleRate: rate, channels, samples };
}
function concat(blocks: Float32Array[]): Float32Array {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0)); let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; } return out;
}

test('exact formats pass through unchanged and reserve horizon for filter delay', () => {
  const inner = innerSink();
  const sink = new AdaptingPcmSink(inner.sink, () => ({ sampleRate: 8000, channels: 2 }));
  assert.equal(sink.horizonMs, 2000 - STREAM_ADAPTER_HORIZON_RESERVE_MS);
  const audio = tone(8000, 2, 800);
  const result = sink.schedule('a', audio, 1000, 100, 200);
  assert.deepEqual(result, { frames: 200, startsAtMs: 1000, endsAtMs: 1025, alignment: 'timeline-only' });
  assert.equal(inner.scheduled[0]!.held, audio.samples); assert.equal(sink.state.mode, 'passthrough');
});

test('contiguous schedules form one continuous stream identical to a single conversion', () => {
  const inner = innerSink();
  const sink = new AdaptingPcmSink(inner.sink, () => ({ sampleRate: 16000, channels: 1 }));
  const audio = tone(8000, 2, 4000);
  let target = 1000, offset = 0;
  for (const frames of [1, 37, 900, 2000, 1062]) {
    const result = sink.schedule(`s${offset}`, audio, target, offset, frames);
    assert.equal(result.frames, frames); offset += frames; target += frames * 1000 / 8000;
  }
  const reference = new StreamingResampler({ inputRate: 8000, outputRate: 16000, channels: 1 });
  const expected = reference.push(new StreamingChannelMapper(2, 1).map(audio.samples));
  const produced = concat(inner.scheduled.map(s => s.samples));
  assert.deepEqual(produced, expected);
  const latency = sink.state.latencyMs; assert.ok(latency > 0 && latency < STREAM_ADAPTER_HORIZON_RESERVE_MS);
  assert.equal(inner.scheduled[0]!.target, 1000 + latency);
  for (let i = 1; i < inner.scheduled.length; i++) {
    const previous = inner.scheduled[i - 1]!;
    assert.equal(inner.scheduled[i]!.target, previous.target + previous.frames * 1000 / previous.sampleRate);
  }
  assert.ok(Math.abs(sink.state.scheduleSkewMs) < 1e-6);
  assert.ok(inner.scheduled.every(s => s.sampleRate === 16000 && s.channels === 1));
  // Adapter-owned plaintext copies are zeroed after the inner sink copied them.
  assert.ok(inner.scheduled.every(s => s.held.every(v => v === 0)));
  assert.ok(audio.samples.some(v => v !== 0), 'caller audio is not modified');
});

test('discontinuity, format change and stopAll start a fresh stream from silence', () => {
  const inner = innerSink(); let format = { sampleRate: 48000, channels: 2 };
  const sink = new AdaptingPcmSink(inner.sink, () => format);
  const audio = tone(44100, 2, 4410);
  sink.schedule('a', audio, 1000, 0, 2205);
  sink.schedule('b', audio, 5000, 2205, 2205); // not contiguous in time
  assert.equal(inner.scheduled[1]!.target, 5000 + sink.state.latencyMs);
  format = { sampleRate: 16000, channels: 2 };
  sink.schedule('c', audio, 5050, 0, 441);
  assert.equal(inner.scheduled[2]!.sampleRate, 16000); assert.equal(inner.scheduled[2]!.target, 5050 + sink.state.latencyMs);
  sink.stopAll(); assert.equal(inner.stops, 1); assert.equal(sink.state.mode, 'idle');
  format = undefined as never;
  assert.throws(() => sink.schedule('d', audio, 6000, 0, 10), /ADAPTED_OUTPUT_UNAVAILABLE/);
});

test('inner truncation reports covered input rounded up and restarts the stream', () => {
  const inner = innerSink(100);
  const sink = new AdaptingPcmSink(inner.sink, () => ({ sampleRate: 16000, channels: 1 }));
  const audio = tone(8000, 1, 1000);
  const result = sink.schedule('a', audio, 1000, 0, 1000);
  assert.ok(result.frames > 0 && result.frames < 1000);
  const innerEnd = inner.scheduled[0]!.target + 100 * 1000 / 16000;
  const nextTarget = 1000 + result.frames * 1000 / 8000;
  sink.schedule('b', audio, nextTarget, result.frames, 100);
  assert.ok(inner.scheduled[1]!.target >= innerEnd, 'restarted stream cannot overlap clipped output');
});

test('drift observations steer the resampler and a resync stops output', () => {
  const inner = innerSink();
  const options: PlaybackStreamAdapterOptions = { drift: { targetFillFrames: 4800, resyncErrorFrames: 2000 }, maxDriftSlewPpm: 1000 };
  const sink = new AdaptingPcmSink(inner.sink, () => ({ sampleRate: 48000, channels: 2 }), options);
  const audio = tone(48000, 2, 9600);
  sink.schedule('a', audio, 1000, 0, 4800);
  assert.equal(sink.state.mode, 'adapting', 'drift correction uses the resampling path even at equal rates');
  assert.equal(sink.observeQueueFill(4800, 10).state, 'warming');
  const tracking = sink.observeQueueFill(5000, 20);
  assert.equal(tracking.state, 'tracking'); assert.ok(tracking.correctionPpm > 0);
  sink.schedule('b', audio, 1100, 4800, 4800);
  assert.ok(sink.state.driftCorrectionPpm > 0);
  assert.equal(sink.observeQueueFill(9000, 30).state, 'resync-required');
  assert.equal(inner.stops, 1); assert.equal(sink.state.mode, 'idle');
  assert.throws(() => new AdaptingPcmSink(inner.sink, () => undefined).observeQueueFill(1, 1), /DRIFT_DISABLED/);
});

test('bounded schedule skew fails closed instead of drifting from the timeline', () => {
  const inner = innerSink();
  const sink = new AdaptingPcmSink(inner.sink, () => ({ sampleRate: 8000, channels: 1 }),
    { drift: { targetFillFrames: 100, resyncErrorFrames: 1_000_000, maxPpm: 5000, proportionalPpmPerFrame: 1000 },
      maxDriftPpm: 5000, maxDriftSlewPpm: 5000, maxScheduleSkewMs: 1 });
  const audio = tone(8000, 1, 80000);
  sink.observeQueueFill(100, 1); sink.observeQueueFill(10000, 2);
  let offset = 0, target = 1000;
  assert.throws(() => { for (;;) { sink.schedule(`x${offset}`, audio, target, offset, 8000); offset += 8000; target += 1000; } }, /SCHEDULE_SKEW/);
  assert.ok(inner.stops >= 1);
});

test('invalid adapter configuration is rejected', () => {
  const inner = innerSink();
  assert.throws(() => new AdaptingPcmSink(inner.sink, () => undefined, { headroom: 0 } as PlaybackStreamAdapterOptions));
  assert.throws(() => new AdaptingPcmSink(inner.sink, () => undefined, { unknown: 1 } as unknown as PlaybackStreamAdapterOptions), /INVALID_STREAM_ADAPTER_CONFIG/);
  assert.throws(() => new AdaptingPcmSink({ ...inner.sink, horizonMs: 5 }, () => undefined));
});

type CommonEvent = Exclude<AndroidAudioEvent, { type: 'interrupted' }>;
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
const route = { endpointId: 'endpoint', routeId: 'route', outputId: 'output', generation: 1, kind: 'unknown' as const };
async function session(streamAdapter?: PlaybackStreamAdapterOptions) {
  const keys = await createControlSigningKey();
  const controls = new ControlVerifier(scope, new Map([['operator', keys.publicKey]]), new Set(['lease', 'emergency-stop']), new MemoryCheckpointStore());
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'private-parent' };
  const media = await packageRendition({ sampleRate: 8000, channels: 2, samples: new Float32Array(16000).fill(0.5) }, 1, context, 'test.wav');
  const copied: AndroidPcmRequest[] = []; let listener: ((event: CommonEvent) => void) | undefined;
  const policy: LeasePolicy = { expiresAtMs: 8000, stopAtMs: 8000, fadeMs: 500, maxLinearGain: 0.5 };
  const options: PlaybackSessionOptions = {
    scope, controls, consentedGainCeiling: 0.75, nowUnixMs: () => 1000,
    // Fixture-only seam: not a real parent E2EE channel or production decoder.
    decodeControlPayload: async () => ({ ...policy }),
    timeline: new ProgramTimeline(1000, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }])),
    resolver: { async resolve() { return { assetId: 'asset', context, manifest: media.privateManifest, sampleRate: 8000, channels: 2, frames: 8000, authorizationValidUntilMs: 9000 }; } },
    transport: { async read(request) { return media.ciphertextChunks[request.chunkIndex]!; } },
    authorizePlayback: async () => ({ allowed: true, validUntilMs: 9000 }),
    ...(streamAdapter ? { streamAdapter } : {}),
  };
  const bridge = {
    subscribe(value: (event: CommonEvent) => void) { listener = value; return () => { listener = undefined; }; },
    enqueue(request: Readonly<AndroidPcmRequest>) { copied.push({ ...request, samples: request.samples.slice() }); },
    updateEnvelope() {}, cancel() {}, cancelAll() {},
  };
  const playback = EndpointPlaybackSession.android({ ...options, bridge, native: { nowMonotonicMs: () => 5000 } });
  listener!({ type: 'route-active', route, sampleRate: 16000, maxChannels: 1 });
  const control = await signControl({ version: '1.0.0', scope, keyId: 'operator', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1,
    issuedAtMs: 1000, expiresAtMs: 10000, action: 'lease', payloadCiphertextBase64: 'dGVzdA==' }, keys.privateKey);
  await playback.join(control);
  return { playback, copied };
}

test('playback session without an adapter keeps the native exact-format check', async () => {
  const { playback } = await session();
  await assert.rejects(playback.pump(), /ANDROID_RATE_ADAPTER_REQUIRED/);
  assert.equal(playback.snapshot().stopReason, 'failure');
});

test('playback session adapts decrypted PCM to the active native format and resyncs fail-closed', async () => {
  const { playback, copied } = await session({ drift: { targetFillFrames: 1600, resyncErrorFrames: 800 } });
  const result = await playback.pump();
  assert.equal(result.status, 'scheduled');
  assert.equal(copied.length, 1);
  assert.equal(copied[0]!.sampleRate, 16000); assert.equal(copied[0]!.channels, 1);
  assert.ok(copied[0]!.samples.length > 0); assert.equal(copied[0]!.gainCeiling, 0.5);
  const snapshot = playback.snapshot();
  assert.equal(snapshot.streamAdapter?.mode, 'adapting'); assert.equal(snapshot.streamAdapter?.realtimeQualified, false);
  assert.equal(playback.observeOutputFill(1600, 5000).state, 'warming');
  assert.equal(playback.observeOutputFill(4000, 5010).state, 'resync-required');
  assert.equal(playback.snapshot().phase, 'stopped'); assert.equal(playback.snapshot().stopReason, 'resync-required');
  await assert.rejects(playback.pump(), /NOT_PLAYING/);
  playback.close();
});
