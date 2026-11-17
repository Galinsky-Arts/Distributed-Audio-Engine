package org.neophilism.dae;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.net.Uri;
import android.webkit.WebResourceResponse;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Emulator evidence (not device evidence): a real Android WebView loads the bundled
 * HTTPS-origin test page, drives WebViewAudioBridge into a real AndroidAudioHost
 * (AudioTrack + JNI C kernel), and checks queue fill and fail-closed shutdown.
 * Nothing here measures audible output, route latency or a physical speaker.
 */
@RunWith(AndroidJUnit4.class)
public final class WebViewAudioBridgeEmulatorTest {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private ActivityScenario<WebViewHostActivity> scenario;
    private final AtomicReference<WebViewHostActivity> activity = new AtomicReference<>();
    private final AtomicReference<WebViewAudioBridge> bridge = new AtomicReference<>();
    private final AtomicReference<AndroidAudioHost> audioHost = new AtomicReference<>();

    private static WebResourceResponse asset(Uri url) {
        String path = url.getPath();
        try {
            if ("/wrapper.js".equals(path)) return new WebResourceResponse("text/javascript", "utf-8",
                new ByteArrayInputStream(WebViewAudioBridge.WRAPPER_SCRIPT.getBytes(StandardCharsets.UTF_8)));
            String name = "/index.html".equals(path) ? "index.html" : "/harness.js".equals(path) ? "harness.js" : null;
            if (name == null) return null;
            return new WebResourceResponse(name.endsWith(".js") ? "text/javascript" : "text/html", "utf-8",
                InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name));
        } catch (IOException error) { return null; }
    }

    @Before public void setUp() throws Exception {
        scenario = ActivityScenario.launch(WebViewHostActivity.class);
        scenario.onActivity(activity::set);
        shell("wm dismiss-keyguard");
        shell("input keyevent 82");
        try { waitFor("window focus", () -> onMain(() -> activity.get().hasWindowFocus())); }
        catch (AssertionError error) {
            throw new AssertionError("no window focus; " + shell("dumpsys window displays").lines()
                .filter(l -> l.contains("mCurrentFocus") || l.contains("mFocusedApp")).map(String::trim)
                .reduce("", (a, b) -> a + b + "; "), error);
        }
    }
    @After public void tearDown() {
        if (scenario != null) {
            scenario.onActivity(a -> { WebViewAudioBridge b = bridge.get(); if (b != null) b.close(); });
            scenario.close();
        }
    }

    private static String shell(String command) {
        try (android.os.ParcelFileDescriptor fd = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command);
             java.io.InputStream in = new android.os.ParcelFileDescriptor.AutoCloseInputStream(fd)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException error) { return ""; }
    }
    private interface Check { boolean ok() throws Exception; }
    private static void waitFor(String what, Check check) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) { if (check.ok()) return; Thread.sleep(50); }
        throw new AssertionError("timed out waiting for " + what);
    }
    private interface MainCall<T> { T call() throws Exception; }
    private <T> T onMain(MainCall<T> call) throws Exception {
        CompletableFuture<T> result = new CompletableFuture<>();
        scenario.onActivity(a -> { try { result.complete(call.call()); } catch (Exception e) { result.completeExceptionally(e); } });
        return result.get(10, TimeUnit.SECONDS);
    }
    /** Evaluates JS in the page; returns the JS string result (null for non-strings). */
    private String js(String script) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        scenario.onActivity(a -> a.webView.evaluateJavascript(script, result::complete));
        Object value = new JSONTokener(result.get(15, TimeUnit.SECONDS)).nextValue();
        return value instanceof String ? (String) value : null;
    }
    private void install(String url) throws Exception {
        onMain(() -> {
            WebViewHostActivity a = activity.get();
            AndroidAudioHost host = new AndroidAudioHost(a);
            audioHost.set(host);
            bridge.set(new WebViewAudioBridge(a.webView, ORIGIN, host, WebViewAudioBridgeEmulatorTest::asset));
            a.webView.loadUrl(url);
            return null;
        });
    }
    private String diagnostics() throws Exception {
        return "bridge failure=" + onMain(() -> bridge.get().lastFailure()) + "; host stop=" + audioHost.get().lastStopCause();
    }
    private JSONArray events() throws Exception { return new JSONArray(js("JSON.stringify(events)")); }
    private JSONObject lastEvent(String type) throws Exception {
        JSONArray all = events();
        for (int i = all.length() - 1; i >= 0; i--) if (type.equals(all.getJSONObject(i).getString("type"))) return all.getJSONObject(i);
        return null;
    }
    private void startPlayback() throws Exception {
        install(ORIGIN + "/index.html");
        waitFor("bundled wrapper", () -> "object".equals(js("typeof nativeAudio")));
        assertEquals("ok:\"subscribed\"", js("attempt(sub)"));
        assertEquals("ok:null", js("attempt(function(){return nativeAudio.queueFill();})"));
        assertEquals("ok:null", js("attempt(function(){nativeAudio.start();})"));
        try { waitFor("route-active", () -> lastEvent("route-active") != null); }
        catch (AssertionError error) { throw new AssertionError("no route; events=" + events() + "; " + diagnostics(), error); }
        JSONObject active = lastEvent("route-active");
        // Exact TypeScript union member: type, route, sampleRate, maxChannels; route has five fields.
        assertEquals(4, active.length());
        assertEquals(5, active.getJSONObject("route").length());
    }

    @Test public void playsSyntheticPcmReportsQueueFillAndFailsClosedOnBadJavaCall() throws Exception {
        startPlayback();
        String played = js("attempt(function(){return playTone('tone-1',300);})");
        assertTrue(played + "; events=" + events() + "; " + diagnostics(), played.startsWith("ok:"));
        JSONObject result = new JSONObject((String) new JSONTokener(played.substring(3)).nextValue());
        int frames = result.getInt("frames");
        JSONObject fill = result.getJSONObject("fill");
        long fillFrames = fill.getLong("fillFrames");
        assertTrue("fill " + fillFrames + " of " + frames, fillFrames > 0 && fillFrames <= frames);
        assertTrue(fill.getDouble("monotonicMs") > 0);
        waitFor("completion of the synthetic tone", () -> lastEvent("completed") != null);
        assertEquals("tone-1", lastEvent("completed").getString("id"));
        assertEquals(0, new JSONObject(js("JSON.stringify(nativeAudio.queueFill())")).getLong("fillFrames"));
        // Well-shaped request whose sample count disagrees with frames: rejected in Java, host closed.
        String bad = js("attempt(function(){var r=routeOf();nativeAudio.enqueue({id:'bad',routeGeneration:r.route.generation," +
            "samples:new Float32Array(3),sampleRate:r.sampleRate,channels:r.maxChannels,frames:64,startAtMonotonicMs:nativeAudio.nowMonotonicMs()+100," +
            "gainCeiling:0.5,fadeStartMonotonicMs:nativeAudio.nowMonotonicMs()+150,stopAtMonotonicMs:nativeAudio.nowMonotonicMs()+150});})");
        assertTrue(bad, bad.startsWith("error:"));
        waitFor("closed bridge", () -> js("attempt(function(){return nativeAudio.nowMonotonicMs();})").startsWith("error:"));
        assertTrue(js("attempt(function(){nativeAudio.start();})").startsWith("error:"));
    }

    @Test public void malformedRequestInScriptClosesTheHost() throws Exception {
        startPlayback();
        assertEquals("error:INVALID_NATIVE_AUDIO_REQUEST", js("attempt(function(){nativeAudio.enqueue({id:'x'});})"));
        waitFor("closed bridge", () -> js("attempt(function(){return nativeAudio.queueFill();})").startsWith("error:"));
    }

    @Test public void untrustedTopLevelOriginCannotUseTheInterface() throws Exception {
        install("https://untrusted.example/");
        Thread.sleep(1000);
        String result = js("(function(){var n=globalThis." + WebViewAudioBridge.INTERFACE_NAME + ";if(!n)return 'absent';" +
            "try{n.now();return 'reachable';}catch(e){return 'refused';}})()");
        assertTrue(result, "refused".equals(result) || "absent".equals(result));
        assertTrue(onMain(() -> { try { bridge.get().close(); return true; } catch (RuntimeException e) { return false; } }));
    }
}
