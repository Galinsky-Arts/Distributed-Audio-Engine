# Android native host (development)

This Java 17 Android library is directly callable from Kotlin or Java. It builds
an AAR containing an AudioTrack host plus a JNI binding to the shared C PCM
kernel. It is not an installable app, published Maven artifact or device-qualified
SDK. Runtime code has no third-party Java/Kotlin dependencies. Minimum Android
API is 26; the initial packaged ABIs are arm64-v8a and x86_64.

## Build and actual boundary tests

Run `sh native/android/test-jni.sh` on Linux with a JDK and C compiler. This runs
real Java/JNI/C calls, not a mocked native library, including PCM ownership,
hard stops, envelope contraction, malformed buffers, route generations, faults,
concurrent close, and timestamp continuity/rollover.

For the Android build, install Java 17 and an already licensed Android SDK with
platform 36, build-tools 35.0.0, NDK 27.0.12077973 and CMake 3.22.1. Set
`ANDROID_HOME` and run `sh native/android/build.sh`. The script downloads the
pinned Gradle 8.13 distribution and checks its official SHA-256 before execution;
it does not accept license agreements, deploy, sign or publish anything. The
Android Gradle plugin is pinned to 8.11.1. The NDK enables flexible page sizes.
CI separately runs JNI tests and the real Android compile/lint task; its AAR is
retained only as a checksum-bound development artifact.

## Host behavior

Create `AndroidAudioHost` with the owning foreground Activity. Subscribe, then
call `start()` after the user's playback action. All controls run on the main
thread. The host acquires audio focus, starts a bounded float-stereo AudioTrack,
and sends silence until the actual routed device and a valid monotonic output
timestamp are observed. No PCM is accepted before route activation. Native and
portable queues require the reported exact sample rate and channel count.

Use `AndroidAudioHost.nowMonotonicMs()` (System.nanoTime) for the bridge clock,
not elapsedRealtime or Unix time. The worker pins a timestamp/frame model for
one route, unwraps the 32-bit playback position, skips missed media frames, and
fails closed on stale/backwards timestamps, more than 10 ms of model residual,
underruns or route changes. That conservative threshold is an implementation
choice, not a measured device accuracy guarantee. Long-term drift correction,
Bluetooth output-delay calibration and acoustic alignment remain qualification
work; a timing discontinuity requires fresh start and timeline rejoin.

Focus loss (including ducking), becoming-noisy, owning-Activity pause/destruction,
and output failures invalidate the queue and stop/flush the driver. Old-session
callbacks cannot revive or stop a newer session. **This host is foreground-only:**
app switching and lock screen stop playback. It does not create a foreground
service or promise background audio. Start/rejoin is explicit, never automatic.

Only `AudioTrack.getRoutedDevice()` supplies active-route observations. Exposed
IDs are ephemeral and opaque. Bluetooth/USB/unknown output remains `unknown`;
accessory names, paired lists and device class do not prove a speaker. The host
requests no microphone, Bluetooth scan or network permissions and never logs or
persists PCM, device names, private manifests or media keys.

## Consumer bridge contract

Translate `Event` into the exact TypeScript event union: route-active has only
`type`, `route`, `sampleRate`, `maxChannels`; completed has `type`, `id`;
interrupted has `type`, `reason`; disconnected has only `type`. Do not serialize
all nullable Java fields. Echo the opaque request ID and routeGeneration exactly.
Construct `NativePcm.Request` with the supplied frames/rate/channels and bounded
samples, and call enqueue synchronously. Native-owned copying completes before
return. The caller must still erase its own temporary PCM views.

Map envelope/cancel/cancelAll directly to host controls, and close/unsubscribe
when leaving. The portable layer must first authenticate controls, rights,
private manifests and recipient keys; these native classes do none of that.
Do not send this plaintext through a server, log, analytics or disk bridge.
Use upstream explicit rate/channel adapters rather than implicit remixing.

Changes to an envelope or cancellation discard any pending worker block before
further delivery. Already accepted AudioTrack/OS/hardware buffers cannot be
recalled by a queue API; interruptions additionally pause/flush the track. Actual
maximum audible stop latency must be measured on each supported route. Completion
reports release of native buffer ownership, not proof of audible playback.

## Remaining release gates

The consumer runtime bridge, actual signed-authority-to-native integration,
protected native state, supported physical devices/routes, interruptions, long
soaks and acoustic measurements remain required. A compiled AAR, JNI tests or
emulator cannot complete DAE-09, DAE-11, DAE-12 or independent security review.

Primary API/build references: Android AudioTrack, AudioTimestamp, AudioRouting,
audio-focus guide and AGP 8.11 compatibility; Gradle release checksums.

## WebView JavaScript bridge (development)

`WebViewAudioBridge` is the Android counterpart of the iOS
[`JavaScriptCoreAudioBridge`](../ios/javascriptcore.md). It uses only the
framework `android.webkit.WebView` (no third-party JavaScript VM, no new
cryptographic protocol, no remote-script loader) and exposes `AndroidAudioHost`
to an application-owned WebView that loads **one trusted, bundled HTTPS origin**
(for example `https://appassets.androidplatform.net` served from APK assets):

```java
// Main thread, foreground Activity. JavaScript must already be enabled.
AndroidAudioHost host = new AndroidAudioHost(activity);
WebViewAudioBridge bridge = new WebViewAudioBridge(webView,
    "https://appassets.androidplatform.net", host, assetLoader::shouldInterceptRequest);
// The bundled page runs WebViewAudioBridge.WRAPPER_SCRIPT first and passes
// globalThis.nativeAudio to EndpointPlaybackSession.android({ bridge: nativeAudio,
//   native: { nowMonotonicMs: () => nativeAudio.nowMonotonicMs() }, ... }).
// On explicit leave/teardown:
bridge.close();
```

- The bridge owns the WebView client: navigations and sub-resources outside the
  trusted origin are refused (HTTP 403), file/content access, pop-up windows and
  mixed content are disabled, and every call rechecks the top-level origin on the
  main thread. A mismatch, malformed call, callback failure or 2 s main-thread
  timeout closes the host and returns only `NATIVE_AUDIO_BRIDGE_FAILURE`.
- The wrapper snapshots data properties only (no getters), requires a real
  non-shared, non-resizable `Float32Array`, type-checks every scalar and passes
  the typed array directly to a `float[]` parameter; PCM is never JSON or base64
  encoded. Java validates ranges, integral fields and exact sample counts again,
  the C kernel rejects non-finite or out-of-range samples, and the bridge-owned
  transfer array is zeroed after the native copy.
- Events reach the page as the exact TypeScript union members (no nullable Java
  fields) through a per-installation, non-writable dispatch hook; only the
  current subscription ticket receives them. Unsubscribe is idempotent and
  ticket-bound; one subscription owner at a time.
- `nativeAudio.queueFill()` returns `{fillFrames, monotonicMs}` (unrendered C-kernel
  frames at the host monotonic clock) or `null` with no active route. An
  `EndpointPlaybackSession` built with that bridge and `streamAdapter.drift` reads it
  through `reportNativeQueueFill()`. This is queue fill for drift control, not an
  AudioTrack buffer, latency or audible-output measurement.

This is **not a complete endpoint runtime**: the bundled page must still provide
the engine's WebCrypto needs and an approved authenticated parent/manifest/key
channel. Android WebView offers no supported binding for the pinned
`@signalapp/libsignal-client` (a Node native library); a mobile Signal binding
remains a separate gate. No fake crypto, temporary key, or plaintext fallback is
installed.

**Verification.** `JavaScriptAudioBridge` (the platform-neutral core) has nine
real Java/JNI/C cases in `tests/JavaScriptAudioBridgeTest.java` (owned copy and
transfer wipe, exact event JSON, envelope contraction, queue fill, malformed
metadata/samples, stale generations, callback failure, hostile event fields,
ticket-bound unsubscribe/rejoin, explicit close/fault) run by `test-jni.sh`. The
WebView adapter is compiled and linted by the Android Gradle build in CI. Neither
job runs a WebView, emulator or device: the WebView typed-array-to-`float[]`
coercion, main-thread hop and origin enforcement have **not** been exercised on
an Android runtime, and no device, route-latency or audible-output claim follows.
