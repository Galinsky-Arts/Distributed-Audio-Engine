package org.neophilism.dae;

import java.util.Arrays;
import java.util.regex.Pattern;

/**
 * Platform-neutral core of the Android JavaScript-to-native audio bridge. It mirrors
 * the iOS {@code JavaScriptCoreAudioBridge}: one subscription owner, strict request
 * validation, owned PCM copies, exact TypeScript event shapes and close-on-fault.
 *
 * <p>Every method must run on the host's owning (main) thread. {@link WebViewAudioBridge}
 * performs that hop for a trusted, application-bundled WebView page. This class
 * authenticates nothing: the portable endpoint session must already have verified
 * signed authority and rights before PCM reaches {@link #enqueue}. It supplies no
 * WebCrypto, module loader, transport, key agreement or parent protocol.
 */
public final class JavaScriptAudioBridge implements AutoCloseable {
    /** Receives native lifecycle events from the host. */
    public interface Events {
        void routeActive(String endpointId, String routeId, String outputId, String kind, long generation,
                         int sampleRate, int maxChannels);
        void interrupted(String reason);
        void disconnected();
        void completed(String id);
    }
    /** Same-endpoint synchronous driver. Implementations copy PCM before returning. */
    public interface Host {
        double nowMonotonicMs();
        Runnable subscribe(Events events);
        void start();
        void enqueue(NativePcm.Request request);
        void updateEnvelope(String id, float gain, double fade, double stop);
        void cancel(String id);
        void cancelAll();
        /** Unrendered native-queue frames, or -1 when no route is active. */
        long queueFillFrames();
        void stop();
        void close();
    }
    /** Delivers one JSON event object (no PCM, keys or manifests) to the owning script. */
    public interface EventSink { void deliver(String json); }

    public static final String FAILURE = "NATIVE_AUDIO_BRIDGE_FAILURE";
    static final double MAX_SAFE = 9_007_199_254_740_991d;
    static final int MAX_SAMPLES = 4 * 1024 * 1024;
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}");
    private static final Pattern REASON = Pattern.compile(
        "focus-loss|becoming-noisy|call|app-suspended|service-destroyed");
    private static final Pattern KIND = Pattern.compile("internal|headphones|unknown");

    private final Host host;
    private final EventSink sink;
    private Runnable detach;
    private boolean subscribed, closed;
    private String lastFailure;
    private long ticket;

    public JavaScriptAudioBridge(Host host, EventSink sink) {
        if (host == null || sink == null) throw new IllegalArgumentException(FAILURE);
        this.host = host; this.sink = sink;
    }

    private static IllegalStateException failure() { return new IllegalStateException(FAILURE); }
    private static double number(double value, double min, double max, boolean integral) {
        if (!Double.isFinite(value) || value < min || value > max || (integral && Math.rint(value) != value)) throw failure();
        return value;
    }
    private static String identifier(String value) {
        if (value == null || !ID.matcher(value).matches()) throw failure();
        return value;
    }
    /** Round toward zero so float conversion never exceeds the requested ceiling. */
    static float roundedGain(double gain) {
        float converted = (float) gain;
        return converted > gain ? Math.nextDown(converted) : converted;
    }
    private interface Call { void run(); }
    /** Any failure closes the bridge and host; caller data never enters the message. */
    private void guarded(Call call) {
        if (closed) throw failure();
        try { call.run(); }
        catch (RuntimeException error) { lastFailure = describe(error); close(); throw failure(); }
    }

    public long subscribe() {
        guarded(() -> {
            if (subscribed || ticket >= (long) MAX_SAFE) throw failure();
            ticket++; subscribed = true;
            Runnable remove = host.subscribe(new Forwarder(ticket));
            if (closed || remove == null) { if (remove != null) remove.run(); throw failure(); }
            detach = remove;
        });
        return ticket;
    }
    /** Idempotent and ticket-bound: a stale handle cannot detach a newer listener. */
    public void unsubscribe(double requested) {
        guarded(() -> { if (number(requested, 1, MAX_SAFE, true) == ticket) detachListener(); });
    }
    public void start() { guarded(() -> { if (!subscribed) throw failure(); host.start(); }); }
    public double now() {
        double[] result = new double[1];
        guarded(() -> result[0] = number(host.nowMonotonicMs(), 0, MAX_SAFE, false));
        return result[0];
    }
    public void enqueue(String id, double routeGeneration, double sampleRate, double channels, double frames,
                        double startAt, double fadeStart, double stopAt, double gainCeiling, float[] samples) {
        guarded(() -> {
            if (!subscribed) throw failure();
            try {
                String checked = identifier(id);
                long generation = (long) number(routeGeneration, 1, MAX_SAFE, true);
                int rate = (int) number(sampleRate, 8000, 192000, true);
                int count = (int) number(channels, 1, 8, true);
                int length = (int) number(frames, 1, Math.floor(MAX_SAMPLES / (double) count), true);
                double start = number(startAt, 0, MAX_SAFE, false), fade = number(fadeStart, 0, MAX_SAFE, false);
                double stop = number(stopAt, 0, MAX_SAFE, false);
                float gain = roundedGain(number(gainCeiling, 0, 1, false));
                if (samples == null || samples.length != length * count) throw failure();
                host.enqueue(new NativePcm.Request(checked, generation, samples, rate, count, length, start, fade, stop, gain));
            } finally {
                // The host copied into native storage; clear the bridge-owned transfer copy.
                if (samples != null) Arrays.fill(samples, 0f);
            }
        });
    }
    public void update(String id, double gainCeiling, double fadeStart, double stopAt) {
        guarded(() -> host.updateEnvelope(identifier(id), roundedGain(number(gainCeiling, 0, 1, false)),
            number(fadeStart, 0, MAX_SAFE, false), number(stopAt, 0, MAX_SAFE, false)));
    }
    public void cancel(String id) { guarded(() -> host.cancel(identifier(id))); }
    public void cancelAll() { guarded(host::cancelAll); }
    public void stop() { guarded(host::stop); }
    /** JSON {@code {"fillFrames":n,"monotonicMs":t}} for {@code observeOutputFill}, or {@code null}. */
    public String queueFill() {
        String[] result = new String[1];
        guarded(() -> {
            long frames = host.queueFillFrames();
            if (frames < 0) { result[0] = null; return; }
            if (frames > 100_000_000L) throw failure();
            double now = number(host.nowMonotonicMs(), 0, MAX_SAFE, false);
            result[0] = "{\"fillFrames\":" + frames + ",\"monotonicMs\":" + json(now) + "}";
        });
        return result[0];
    }
    /** Called by the script wrapper when it rejects a request before crossing into Java. */
    public void fault() { close(); }
    public boolean isClosed() { return closed; }
    /** Diagnostics for tests: exception class and throwing frame only, never its
     * message or any caller-supplied value. */
    String lastFailure() { return lastFailure; }
    static String describe(Throwable error) {
        StackTraceElement[] frames = error.getStackTrace();
        String at = frames.length == 0 ? "?" : frames[0].getClassName() + "." + frames[0].getMethodName();
        return error.getClass().getName() + " at " + at;
    }

    private void detachListener() {
        subscribed = false;
        Runnable remove = detach; detach = null;
        if (remove != null) remove.run();
    }
    @Override public void close() {
        if (closed) return;
        closed = true;
        try { detachListener(); } catch (RuntimeException ignored) { /* host close below still runs */ }
        host.close();
    }

    static String json(double value) {
        if (Math.rint(value) == value && Math.abs(value) <= MAX_SAFE) return Long.toString((long) value);
        return Double.toString(value);
    }
    /** Identifiers are pattern-checked; quote anyway so no caller value can alter structure. */
    static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20 || c > 0x7e) out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    private final class Forwarder implements Events {
        private final long owner;
        Forwarder(long owner) { this.owner = owner; }
        private void forward(String json) {
            if (closed || !subscribed || owner != ticket) return;
            try { sink.deliver(json); } catch (RuntimeException error) { close(); }
        }
        private void reject() { close(); }
        @Override public void routeActive(String endpointId, String routeId, String outputId, String kind,
                                          long generation, int sampleRate, int maxChannels) {
            if (endpointId == null || routeId == null || outputId == null || kind == null || !KIND.matcher(kind).matches() ||
                generation < 1 || generation > (long) MAX_SAFE || sampleRate < 8000 || sampleRate > 192000 ||
                maxChannels < 1 || maxChannels > 8 || !ID.matcher(endpointId).matches() ||
                !ID.matcher(routeId).matches() || !ID.matcher(outputId).matches()) { reject(); return; }
            // Exact TypeScript union member: no nullable Java fields are serialized.
            forward("{\"type\":\"route-active\",\"route\":{\"endpointId\":" + quote(endpointId) +
                ",\"routeId\":" + quote(routeId) + ",\"outputId\":" + quote(outputId) + ",\"kind\":" + quote(kind) +
                ",\"generation\":" + generation + "},\"sampleRate\":" + sampleRate + ",\"maxChannels\":" + maxChannels + "}");
        }
        @Override public void interrupted(String reason) {
            if (reason == null || !REASON.matcher(reason).matches()) { reject(); return; }
            forward("{\"type\":\"interrupted\",\"reason\":" + quote(reason) + "}");
        }
        @Override public void disconnected() { forward("{\"type\":\"disconnected\"}"); }
        @Override public void completed(String id) {
            if (id == null || !ID.matcher(id).matches()) { reject(); return; }
            forward("{\"type\":\"completed\",\"id\":" + quote(id) + "}");
        }
    }
}
