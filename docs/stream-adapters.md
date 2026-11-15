# Continuous stream adapters: rate, channels and drift

`StreamingResampler`, `StreamingChannelMapper` and `DriftController` close the
"explicit rate/channel/drift adapter" gap left by the offline
[`convertPcmFormat`](pcm-format.md). They run only at an authorized endpoint:
on decrypted, currently authorized PCM immediately before a native/browser sink,
or on locally captured PCM before encryption. They never run at a relay, never
grant or extend playback authority and never claim physical synchronization.

```ts
const resampler = new StreamingResampler({ inputRate: 44100, outputRate: 48000, channels: 2, headroom: 0.7 });
const mapper = new StreamingChannelMapper(2, 1);           // explicit stereo -> mono average
const drift = new DriftController({ targetFillFrames: 4800, resyncErrorFrames: 4000 });

for (const block of authorizedBlocks) sink.enqueue(mapper.map(resampler.push(block)));
const decision = drift.observe(sink.queuedFrames, monotonicNowMs());
if (decision.state === 'tracking') resampler.setDriftCorrectionPpm(decision.correctionPpm);
else if (decision.state === 'resync-required') { stopOutput(); requireFreshJoin(); }
sink.enqueue(mapper.map(resampler.flush()));                 // end of stream only
```

## Resampler

- Blackman-windowed sinc, 512 precomputed unit-sum phases with linear
  interpolation between neighbouring phases, so any fractional position and any
  drift-adjusted ratio preserve a constant signal.
- The anti-alias cutoff is `0.9 * min(1, outputRate / (inputRate * (1 + maxDriftPpm)))`,
  so the largest permitted correction cannot move the passband above output Nyquist.
- Filter history and the next output position are carried across `push` calls.
  The integer frame and fractional offset advance separately, so the floating-point
  operation sequence is independent of chunking: **any split of a stream yields
  byte-identical output** to a single push (tested for up- and down-sampling,
  mono and stereo, with chunk sizes from 1 frame).
- The stream starts from silence and `flush()` extends with silence. Fixed delay
  is `latencyInputFrames` (the filter radius). Nothing is invented from edge samples.
- Sample peaks can exceed the input peak (a band-limited discrete step overshoots by
  about 26%). Overshoot is clamped to [-1, 1] **and counted** in `clippedSamples`.
  Use `headroom` (uniform pre-gain in (0, 1]) to avoid clamping; the adapter never
  normalizes upward.
- `push` accepts at most `maxPushFrames` (default 16,384) and validates finite
  samples in [-1, 1]. It allocates per call and is not real-time qualified
  (`realtimeQualified: false`); call it from a worker or the host's producer
  thread, not a hard real-time audio callback.

## Drift correction

`setDriftCorrectionPpm` requests a correction bounded by `maxDriftPpm` (default
1,000, ceiling 5,000). Each `push` moves the applied value at most
`maxDriftSlewPpm` (default 50) toward the request, so the pitch change is gradual
(1,000 ppm is about 1.7 cents).

`DriftController` is a clamped PI controller over sink queue fill:

- more frames queued than the target means the sink drains slowly, so the
  correction is positive (consume input faster);
- the integral term has anti-windup, and the output is clamped to `maxPpm`;
- an observation gap, a non-increasing monotonic time or an absolute fill error
  beyond `resyncErrorFrames` returns `resync-required` and latches until `reset()`.
  The caller must stop output and perform a fresh authenticated join. The
  controller never skips, time-stretches or silently continues.

A simulated closed loop converges a 200 ppm sink mismatch to within 60 frames of
the target fill without a resync. That is a software model only.

## What this does not establish

No physical route latency, Bluetooth/wired delay, acoustic alignment, multi-device
synchronization or six-hour soak is measured or implied. The disciplined clock's
diagnostic drift estimate is deliberately not fed in automatically; queue fill at
the actual sink is the controlled variable. Native hosts keep their exact
rate/layout checks; these adapters prepare PCM to match them and are not an
implicit fallback.
