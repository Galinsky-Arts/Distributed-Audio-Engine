import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingResampler, StreamingChannelMapper, DriftController } from '../src/index.js';

const sine = (rate: number, frequency: number, frames: number, channels = 1, amplitude = 0.5) => {
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++)
    out[i * channels + c] = amplitude * Math.sin(2 * Math.PI * frequency * i / rate + c);
  return out;
};
const concat = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
};
const run = (r: StreamingResampler, input: Float32Array, sizes: number[]) => {
  const parts: Float32Array[] = []; let offset = 0, i = 0;
  while (offset < input.length) {
    const take = Math.min(sizes[i++ % sizes.length]! * r.channels, input.length - offset);
    parts.push(r.push(input.subarray(offset, offset + take).slice())); offset += take;
  }
  parts.push(r.flush()); return concat(parts);
};

test('stream adapter: arbitrary chunking yields byte-identical output to a single push', () => {
  for (const [from, to, channels] of [[44100, 48000, 2], [48000, 44100, 1], [16000, 48000, 1], [96000, 48000, 2]] as const) {
    const input = sine(from, 440, 6000, channels);
    const whole = run(new StreamingResampler({ inputRate: from, outputRate: to, channels }), input, [6000]);
    const chunked = run(new StreamingResampler({ inputRate: from, outputRate: to, channels }), input, [1, 7, 128, 333, 1024]);
    assert.deepEqual(chunked, whole);
  }
});
test('stream adapter: frame count matches the rate ratio and DC is preserved after the leading transient', () => {
  const r = new StreamingResampler({ inputRate: 44100, outputRate: 48000, channels: 1 });
  const input = new Float32Array(44100).fill(0.25);
  const out = run(r, input, [4096]);
  assert.ok(Math.abs(out.length - 48000) <= 1, `frames ${out.length}`);
  const settle = r.state.latencyInputFrames * 2 + 8;
  for (let i = settle; i < out.length - settle; i++) assert.ok(Math.abs(out[i]! - 0.25) < 1e-4, `sample ${i}=${out[i]}`);
  assert.equal(r.state.realtimeQualified, false);
});
test('stream adapter: an in-band tone keeps its amplitude and an out-of-band tone is attenuated on downsampling', () => {
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const pass = run(new StreamingResampler({ inputRate: 48000, outputRate: 16000, channels: 1 }), sine(48000, 1000, 48000), [2048]);
  const stop = run(new StreamingResampler({ inputRate: 48000, outputRate: 16000, channels: 1 }), sine(48000, 12000, 48000), [2048]);
  const body = (x: Float32Array) => x.subarray(500, x.length - 500);
  assert.ok(Math.abs(rms(body(pass)) - 0.5 / Math.SQRT2) < 0.01);
  assert.ok(rms(body(stop)) < 0.01, `alias rms ${rms(body(stop))}`);
});
test('stream adapter: drift correction is bounded, slew-limited and changes the consumption rate', () => {
  const r = new StreamingResampler({ inputRate: 48000, outputRate: 48000, channels: 1, maxDriftPpm: 1000, maxDriftSlewPpm: 100 });
  assert.throws(() => r.setDriftCorrectionPpm(1001), /INVALID_NUMBER/);
  r.setDriftCorrectionPpm(1000);
  const block = new Float32Array(4800).fill(0.1);
  r.push(block); assert.equal(r.state.driftCorrectionPpm, 100);
  for (let i = 0; i < 20; i++) r.push(block);
  assert.equal(r.state.driftCorrectionPpm, 1000);
  assert.ok(Math.abs(r.state.effectiveStep - 1.001) < 1e-12);
  // Faster consumption produces fewer output frames than accepted input frames.
  assert.ok(r.state.outputFramesProduced < r.state.inputFramesAccepted - r.state.latencyInputFrames);
});
test('stream adapter: inputs are validated and flushed streams refuse more audio', () => {
  const r = new StreamingResampler({ inputRate: 8000, outputRate: 16000, channels: 2, maxPushFrames: 4 });
  assert.throws(() => r.push(new Float32Array(3)), /SHAPE/);
  assert.throws(() => r.push(new Float32Array(10)), /PUSH_LIMIT/);
  assert.throws(() => r.push(new Float32Array([2, 0])), /INVALID_NUMBER/);
  assert.throws(() => r.push(new Float32Array([NaN, 0])), /INVALID_NUMBER/);
  r.flush(); assert.throws(() => r.push(new Float32Array(2)), /FLUSHED/);
  assert.throws(() => new StreamingResampler({ inputRate: 1000, outputRate: 48000, channels: 1 }));
  assert.throws(() => new StreamingResampler({ inputRate: 48000, outputRate: 48000, channels: 1, extra: 1 } as never), /CONFIG/);
  assert.throws(() => new StreamingResampler({ inputRate: 48000, outputRate: 48000, channels: 1, maxDriftPpm: 6000 }));
});
test('stream adapter: filter overshoot is clamped and counted, and headroom avoids it', () => {
  const square = new Float32Array(8000).map((_, i) => (Math.floor(i / 20) % 2 ? 1 : -1));
  const hot = new StreamingResampler({ inputRate: 8000, outputRate: 44100, channels: 1 });
  const out = run(hot, square, [1000]);
  assert.ok(out.every(v => v >= -1 && v <= 1)); assert.ok(hot.state.clippedSamples > 0);
  const safe = new StreamingResampler({ inputRate: 8000, outputRate: 44100, channels: 1, headroom: 0.7 });
  run(safe, square, [1000]); assert.equal(safe.state.clippedSamples, 0);
});
test('stream adapter: channel mapping uses the explicit offline policy', () => {
  assert.deepEqual([...new StreamingChannelMapper(1, 2).map(new Float32Array([0.5, -0.25]))], [0.5, 0.5, -0.25, -0.25]);
  assert.deepEqual([...new StreamingChannelMapper(2, 1).map(new Float32Array([1, -1, 0.5, 0.25]))], [0, 0.375]);
  assert.throws(() => new StreamingChannelMapper(3, 2), /MATRIX_REQUIRED/);
  assert.throws(() => new StreamingChannelMapper(2, 1, [[1, 1]]), /GAIN_EXCEEDED/);
  assert.deepEqual([...new StreamingChannelMapper(3, 1, [[0, 0, 1]]).map(new Float32Array([0.1, 0.2, -0.75]))], [-0.75]);
});
test('drift controller: tracks small fill error within bounds and fails closed on gaps, reversal or large error', () => {
  const c = new DriftController({ targetFillFrames: 4800, resyncErrorFrames: 2400, maxPpm: 300 });
  assert.equal(c.observe(4800, 0).state, 'warming');
  const d = c.observe(5000, 100);
  assert.equal(d.state, 'tracking'); assert.ok(d.correctionPpm > 0 && d.correctionPpm <= 300);
  const low = c.observe(4000, 200); assert.equal(low.state, 'tracking'); assert.ok(low.correctionPpm < 0);
  for (let t = 300; t < 60000; t += 100) { const x = c.observe(7000, t); assert.ok(x.correctionPpm <= 300); }
  assert.deepEqual(c.observe(4800, 50000), { state: 'resync-required', correctionPpm: 0, reason: 'NON_MONOTONIC_OBSERVATION' });
  assert.equal(c.observe(4800, 70000).state, 'resync-required');
  c.reset(); c.observe(4800, 0);
  assert.deepEqual(c.observe(4800, 5000), { state: 'resync-required', correctionPpm: 0, reason: 'OBSERVATION_GAP' });
  c.reset(); c.observe(4800, 0);
  assert.equal((c.observe(9000, 100) as { reason: string }).reason, 'FILL_ERROR_EXCEEDED');
});
test('drift controller + resampler: closed loop converges a simulated 200 ppm sink mismatch', () => {
  // Producer writes 48000 Hz through the resampler; sink drains 200 ppm slow.
  const r = new StreamingResampler({ inputRate: 48000, outputRate: 48000, channels: 1, maxDriftPpm: 1000, maxDriftSlewPpm: 20 });
  const c = new DriftController({ targetFillFrames: 4800, resyncErrorFrames: 4000, maxPpm: 1000,
    proportionalPpmPerFrame: 1, integralPpmPerFrameSecond: 2 });
  let fill = 4800, drainCarry = 0; const block = new Float32Array(480).fill(0.1);
  let last = 0;
  for (let step = 0; step < 6000; step++) {
    fill += r.push(block).length;
    drainCarry += 480 * (1 - 200e-6); const drained = Math.floor(drainCarry); drainCarry -= drained; fill -= drained;
    const decision = c.observe(fill, step * 10);
    assert.notEqual(decision.state, 'resync-required');
    if (decision.state === 'tracking') r.setDriftCorrectionPpm(decision.correctionPpm);
    last = fill;
  }
  assert.ok(Math.abs(last - 4800) < 60, `fill ${last}`);
  assert.ok(Math.abs(r.state.driftCorrectionPpm - 200) < 40, `ppm ${r.state.driftCorrectionPpm}`);
});
