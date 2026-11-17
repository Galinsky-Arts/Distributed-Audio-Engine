package org.neophilism.dae;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Real Java/JNI/C bridge calls with a synthetic clock and route; no AudioTrack or device. */
public final class JavaScriptAudioBridgeTest {
    static final class ScriptHost implements JavaScriptAudioBridge.Host {
        final NativePcm kernel = new NativePcm(8000, 2);
        double now = 1000; long generation; JavaScriptAudioBridge.Events listener; boolean closed, active;
        @Override public double nowMonotonicMs() { return now; }
        @Override public Runnable subscribe(JavaScriptAudioBridge.Events events) {
            if (closed || listener != null) throw new IllegalStateException("SUBSCRIPTION_UNAVAILABLE");
            listener = events;
            return () -> { stop(); listener = null; };
        }
        @Override public void start() {
            if (closed || listener == null) throw new IllegalStateException("FOREGROUND_AUDIO_UNAVAILABLE");
            generation++; kernel.activate(generation, now); active = true;
            listener.routeActive("test-endpoint", "test-route", "test-output", "unknown", generation, 8000, 2);
        }
        @Override public void enqueue(NativePcm.Request request) { kernel.enqueue(request, now); }
        @Override public void updateEnvelope(String id, float gain, double fade, double stop) { kernel.updateEnvelope(id, gain, fade, stop); }
        @Override public void cancel(String id) { kernel.cancel(id); }
        @Override public void cancelAll() { kernel.cancelAll(); }
        @Override public long queueFillFrames() { return active ? kernel.pendingFrames() : -1; }
        @Override public void stop() { kernel.deactivate(); active = false; generation++; if (listener != null) listener.disconnected(); }
        @Override public void close() { if (!closed) { stop(); listener = null; closed = true; kernel.close(); } }
        float[] render(double time, int frames) {
            ByteBuffer out = ByteBuffer.allocateDirect(frames * 8).order(ByteOrder.nativeOrder());
            kernel.render(generation, time, frames, out);
            for (String id : kernel.drainCompleted()) listener.completed(id);
            float[] result = new float[frames * 2];
            for (int i = 0; i < result.length; i++) result[i] = out.getFloat(i * 4);
            return result;
        }
    }
    static final class Setup {
        final ScriptHost host = new ScriptHost();
        final List<String> events = new ArrayList<>();
        final JavaScriptAudioBridge bridge = new JavaScriptAudioBridge(host, events::add);
        long ticket;
        Setup(boolean start) { ticket = bridge.subscribe(); if (start) bridge.start(); }
    }
    static float[] filled(int count, float value) { float[] s = new float[count]; Arrays.fill(s, value); return s; }
    static void enqueue(JavaScriptAudioBridge b, String id, double gen, double frames, double start, double stop, double gain, float[] samples) {
        b.enqueue(id, gen, 8000, 2, frames, start, stop, stop, gain, samples);
    }
    static void near(float actual, float expected) { assert Math.abs(actual - expected) < 0.00001f : actual + " != " + expected; }
    static void fails(Runnable call) {
        boolean failed = false;
        try { call.run(); } catch (IllegalStateException error) { failed = JavaScriptAudioBridge.FAILURE.equals(error.getMessage()); }
        assert failed : "expected generic bridge failure";
    }

    static void ownedCopyExactEventsAndCompletion() {
        Setup s = new Setup(true);
        assert s.events.get(0).equals("{\"type\":\"route-active\",\"route\":{\"endpointId\":\"test-endpoint\",\"routeId\":\"test-route\"," +
            "\"outputId\":\"test-output\",\"kind\":\"unknown\",\"generation\":1},\"sampleRate\":8000,\"maxChannels\":2}") : s.events;
        float[] samples = filled(16, 0.5f);
        enqueue(s.bridge, "dispatch-1", 1, 8, 1000, 1001, 0.5, samples);
        for (float value : samples) assert value == 0f; // bridge-owned transfer copy cleared after native copy
        float[] out = s.host.render(1000, 8);
        near(out[0], 0.25f); near(out[15], 0.25f);
        assert s.events.get(1).equals("{\"type\":\"completed\",\"id\":\"dispatch-1\"}") : s.events;
        s.bridge.close(); assert s.host.closed;
    }
    static void envelopeContractionAndHardStop() {
        Setup s = new Setup(true);
        enqueue(s.bridge, "dispatch-1", 1, 16, 1000, 1002, 1, filled(32, 1));
        s.bridge.update("dispatch-1", 0.25, 1000.5, 1001);
        s.bridge.update("dispatch-1", 1, 5000, 5000); // cannot widen
        float[] out = s.host.render(1000, 16);
        near(out[0], 0.25f); near(out[2 * 12], 0); near(out[2 * 15], 0);
        s.bridge.close();
    }
    static void queueFillReportsUnrenderedFrames() {
        Setup s = new Setup(false);
        assert s.bridge.queueFill() == null; // no active route
        s.bridge.start();
        assert s.bridge.queueFill().equals("{\"fillFrames\":0,\"monotonicMs\":1000}") : s.bridge.queueFill();
        enqueue(s.bridge, "dispatch-1", 1, 16, 1000, 1002, 1, filled(32, 0.1f));
        s.host.now = 1000.5;
        assert s.bridge.queueFill().equals("{\"fillFrames\":16,\"monotonicMs\":1000.5}") : s.bridge.queueFill();
        s.host.render(1000, 8);
        assert s.bridge.queueFill().startsWith("{\"fillFrames\":8,") : s.bridge.queueFill();
        s.bridge.close();
    }
    static void invalidMetadataAndSamplesCloseHost() {
        Object[][] bad = {
            {"bad/id", 1d, 8d, 0.5}, {"dispatch-1", 1.5, 8d, 0.5}, {"dispatch-1", 1d, 0d, 0.5},
            {"dispatch-1", 1d, 8d, Double.NaN}, {"dispatch-1", 1d, 8d, 1.5}, {"dispatch-1", 1d, 9d, 0.5}, {null, 1d, 8d, 0.5}};
        for (Object[] row : bad) {
            Setup s = new Setup(true);
            fails(() -> enqueue(s.bridge, (String) row[0], (Double) row[1], (Double) row[2], 1000, 1001, (Double) row[3], filled(16, 0.5f)));
            assert s.bridge.isClosed() && s.host.closed;
            fails(s.bridge::start);
        }
        Setup nan = new Setup(true);
        float[] samples = filled(16, 0.5f); samples[3] = Float.NaN;
        fails(() -> enqueue(nan.bridge, "dispatch-1", 1, 8, 1000, 1001, 0.5, samples));
        assert nan.host.closed;
        Setup missing = new Setup(true);
        fails(() -> enqueue(missing.bridge, "dispatch-1", 1, 8, 1000, 1001, 0.5, null));
        assert missing.host.closed;
        Setup stale = new Setup(true);
        fails(() -> enqueue(stale.bridge, "dispatch-1", 2, 8, 1000, 1001, 0.5, filled(16, 0.5f)));
        assert stale.host.closed;
    }
    static void enqueueBeforeSubscribeOrStartFails() {
        ScriptHost host = new ScriptHost(); List<String> events = new ArrayList<>();
        JavaScriptAudioBridge bridge = new JavaScriptAudioBridge(host, events::add);
        fails(bridge::start); assert host.closed;
        Setup s = new Setup(false);
        fails(() -> enqueue(s.bridge, "dispatch-1", 1, 8, 1000, 1001, 0.5, filled(16, 0.5f)));
        assert s.host.closed;
    }
    static void callbackFailureCloses() {
        ScriptHost host = new ScriptHost();
        JavaScriptAudioBridge bridge = new JavaScriptAudioBridge(host, json -> { throw new IllegalStateException("listener"); });
        bridge.subscribe(); bridge.start();
        assert bridge.isClosed() && host.closed;
    }
    static void hostileEventFieldsClose() {
        Setup s = new Setup(false);
        s.host.listener.routeActive("bad\"id", "r", "o", "unknown", 1, 8000, 2);
        assert s.bridge.isClosed() && s.events.isEmpty();
        Setup t = new Setup(false);
        t.host.listener.interrupted("<script>");
        assert t.bridge.isClosed() && t.events.isEmpty();
    }
    static void unsubscribeIsTicketBoundAndRejoinWorks() {
        Setup s = new Setup(true);
        s.bridge.unsubscribe(s.ticket + 7); // stale/foreign handle: no effect
        assert s.host.listener != null;
        s.bridge.unsubscribe(s.ticket);
        assert s.host.listener == null;
        s.bridge.unsubscribe(s.ticket); // idempotent
        long second = s.bridge.subscribe();
        assert second == s.ticket + 1;
        s.bridge.unsubscribe(s.ticket); // old ticket cannot detach the new listener
        assert s.host.listener != null;
        s.bridge.start();
        assert s.events.get(s.events.size() - 1).contains("\"generation\":3") : s.events;
        fails(() -> s.bridge.subscribe()); // one subscription owner
        assert s.host.closed;
    }
    static void explicitCloseAndFault() {
        Setup s = new Setup(true);
        s.bridge.close(); s.bridge.close();
        assert s.host.closed && s.bridge.isClosed();
        fails(() -> s.bridge.now());
        fails(() -> s.bridge.queueFill());
        Setup f = new Setup(true);
        f.bridge.fault();
        assert f.host.closed;
        assert JavaScriptAudioBridge.roundedGain(0.1) <= 0.1;
        assert JavaScriptAudioBridge.quote("a\"\\\u0001").equals("\"a\\\"\\\\\\u0001\"");
    }

    public static void main(String[] args) {
        Runnable[] tests = {JavaScriptAudioBridgeTest::ownedCopyExactEventsAndCompletion,
            JavaScriptAudioBridgeTest::envelopeContractionAndHardStop, JavaScriptAudioBridgeTest::queueFillReportsUnrenderedFrames,
            JavaScriptAudioBridgeTest::invalidMetadataAndSamplesCloseHost, JavaScriptAudioBridgeTest::enqueueBeforeSubscribeOrStartFails,
            JavaScriptAudioBridgeTest::callbackFailureCloses, JavaScriptAudioBridgeTest::hostileEventFieldsClose,
            JavaScriptAudioBridgeTest::unsubscribeIsTicketBoundAndRejoinWorks, JavaScriptAudioBridgeTest::explicitCloseAndFault};
        for (Runnable test : tests) test.run();
        System.out.println("Android JavaScript bridge: " + tests.length + " cases passed against the real JNI/C queue");
    }
}
