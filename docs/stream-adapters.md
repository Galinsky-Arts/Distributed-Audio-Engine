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

## Playback session seam

`AdaptingPcmSink` wraps an exact-format sink (`AndroidAudioSink`, `IOSAudioSink`)
for `EndpointProgramPlayer`, and `EndpointPlaybackSession` installs it only when
the application passes `streamAdapter` options. Without the option the native
`*_RATE_ADAPTER_REQUIRED` / `*_CHANNEL_ADAPTER_REQUIRED` checks apply unchanged.

```ts
const session = EndpointPlaybackSession.android({ ...options, bridge, native,
  streamAdapter: { headroom: 0.8, drift: { targetFillFrames: 4800, resyncErrorFrames: 4000 } } });
// Host reports its native queue fill; tracking adjusts the resampler only.
const decision = session.observeOutputFill(queuedFrames, monotonicNowMs);
// resync-required => session stops ('resync-required'); a fresh signed join is needed.
// Or let the session read the host's own fill through the bridge's queueFill():
const fromHost = session.reportNativeQueueFill(); // null when no route is active
```

Both native hosts now report fill themselves: the C kernel's `pending_frames`
(scheduled frames after the last render, up to each voice's stop) is exposed as
`AndroidAudioHost.queueFillFrames()` / `IOSAudioHost.queueFillFrames()` and through
the WebView and JavaScriptCore bridges as `queueFill()`. It measures the native
queue, not OS/hardware buffers, route latency or audible output.

- Conversion happens in the endpoint JavaScript runtime on decrypted, currently
  authorized PCM, immediately before the native bridge copy. The native sink still
  applies authority envelopes, deadlines, queue limits and route generation to the
  converted block; the adapter never grants or extends authority.
- The format comes from the sink's active route (`outputFormat()`); a route or
  format change interrupts the session as before and the next join starts a
  fresh stream.
- Contiguous player schedules (including clip boundaries at the same input
  format) are one continuous resampler stream: the converted output is identical
  to a single conversion of the whole signal (tested), and each native block
  starts exactly where the previous one ended. The whole stream is delayed by the
  filter radius plus one frame (`latencyMs`, under 6 ms); the adapter reports a
  horizon 6 ms below the native sink's so delayed output stays inside it.
- A time discontinuity, format change, `stopAll` or native truncation starts a
  fresh stream from silence. On truncation the covered input is rounded up so the
  next stream cannot overlap queued output.
- With drift correction, nominal schedule times diverge slowly from timeline
  time. `scheduleSkewMs` is reported and an absolute skew above
  `maxScheduleSkewMs` (default 25 ms) stops output with
  `STREAM_ADAPTER_SCHEDULE_SKEW` rather than drifting silently.
- Adapter-owned plaintext copies are zeroed after the native bridge copies them,
  and the resampler history is zeroed (`dispose()`) when a stream ends.

Pending: the shipped Android AudioTrack/JNI and iOS AVAudioEngine hosts do not yet
emit a queue-fill observation to JavaScript, so `observeOutputFill` must be fed by
the embedding application. Native-side fill reporting needs device builds and is
not exercised here.

## What this does not establish

No physical route latency, Bluetooth/wired delay, acoustic alignment, multi-device
synchronization or six-hour soak is measured or implied. The disciplined clock's
diagnostic drift estimate is deliberately not fed in automatically; queue fill at
the actual sink is the controlled variable. Native hosts keep their exact
rate/layout checks; these adapters prepare PCM to match them and are not an
implicit fallback.
