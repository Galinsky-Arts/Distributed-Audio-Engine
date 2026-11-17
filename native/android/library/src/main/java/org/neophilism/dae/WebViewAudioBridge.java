package org.neophilism.dae;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * Android counterpart of the iOS JavaScriptCore bridge: exposes {@link AndroidAudioHost}
 * to the endpoint runtime running in an application-owned {@link WebView} that loads
 * only one trusted, application-bundled HTTPS origin (for example
 * {@code https://appassets.androidplatform.net} served from APK assets).
 *
 * <p>The bridge owns the WebView's {@link WebViewClient}: every navigation or
 * sub-resource outside the trusted origin is refused, so no other origin or frame can
 * reach the injected interface. Each call hops to the main thread, rechecks the
 * top-level origin and closes the host on any fault. It never evaluates remote code,
 * installs a crypto polyfill, or supplies key agreement, Signal enrollment or media
 * delivery; those remain the bundled endpoint runtime's approved responsibilities.
 */
public final class WebViewAudioBridge implements AutoCloseable {
    /** Serves trusted-origin requests (e.g. {@code WebViewAssetLoader::shouldInterceptRequest}). */
    public interface TrustedResources { WebResourceResponse load(Uri url); }

    public static final String INTERFACE_NAME = "__daeNativeAudio";
    private static final long CALL_TIMEOUT_MS = 2000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WebView view;
    private final String origin;
    private final String dispatchName = "__daeAudioEvents_" + UUID.randomUUID().toString().replace("-", "");
    private final JavaScriptAudioBridge core;
    private volatile boolean closed;

    public WebViewAudioBridge(WebView view, String trustedOrigin, AndroidAudioHost host, TrustedResources resources) {
        requireMain();
        this.view = Objects.requireNonNull(view);
        Objects.requireNonNull(host); Objects.requireNonNull(resources);
        origin = canonicalOrigin(Uri.parse(Objects.requireNonNull(trustedOrigin)));
        if (origin == null) { host.close(); throw new IllegalArgumentException("TRUSTED_HTTPS_ORIGIN_REQUIRED"); }
        WebSettings settings = view.getSettings();
        if (!settings.getJavaScriptEnabled()) { host.close(); throw new IllegalStateException("JAVASCRIPT_REQUIRED"); }
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.setWebViewClient(new TrustedClient(resources));
        core = new JavaScriptAudioBridge(new HostPort(host), this::dispatch);
        view.addJavascriptInterface(new Binding(), INTERFACE_NAME);
    }

    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("MAIN_THREAD_REQUIRED");
    }
    static String canonicalOrigin(Uri uri) {
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty() ||
            uri.getUserInfo() != null) return null;
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) return null;
        if (uri.getQuery() != null || uri.getFragment() != null) return null;
        int port = uri.getPort();
        return "https://" + uri.getHost().toLowerCase(java.util.Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
    }
    private boolean trusted(Uri url) { return url != null && origin.equals(canonicalOrigin(url.buildUpon().path(null).clearQuery().fragment(null).build())); }
    private boolean trustedTop() { String url = view.getUrl(); return url != null && trusted(Uri.parse(url)); }

    /** Events arrive on the main thread from AndroidAudioHost. JSON holds no PCM or keys. */
    private void dispatch(String json) {
        if (closed || !trustedTop()) throw new IllegalStateException(JavaScriptAudioBridge.FAILURE);
        view.evaluateJavascript("(function(d){if(typeof d==='function')d(" + json + ");})(globalThis['" + dispatchName + "'])", null);
    }

    private <T> T onMain(Callable<T> call) {
        if (closed) throw new IllegalStateException(JavaScriptAudioBridge.FAILURE);
        FutureTask<T> task = new FutureTask<>(() -> {
            if (closed) throw new IllegalStateException(JavaScriptAudioBridge.FAILURE);
            if (!trustedTop()) { close(); throw new IllegalStateException(JavaScriptAudioBridge.FAILURE); }
            return call.call();
        });
        if (Looper.myLooper() == Looper.getMainLooper()) task.run();
        else if (!main.post(task)) throw new IllegalStateException(JavaScriptAudioBridge.FAILURE);
        try { return task.get(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt(); main.post(this::close);
            throw new IllegalStateException(JavaScriptAudioBridge.FAILURE);
        } catch (Exception error) {
            task.cancel(false); main.post(this::close);
            // Never include caller-controlled messages, media or keys in errors.
            throw new IllegalStateException(JavaScriptAudioBridge.FAILURE);
        }
    }

    @Override public void close() {
        requireMain();
        if (closed) return;
        closed = true;
        try { core.close(); } finally { view.removeJavascriptInterface(INTERFACE_NAME); }
    }

    /** Methods run on the WebView's JavaBridge thread; each hops to the main thread. */
    public final class Binding {
        @JavascriptInterface public String dispatchName() { return onMain(() -> dispatchName); }
        @JavascriptInterface public double subscribe() { return onMain(() -> (double) core.subscribe()); }
        @JavascriptInterface public void unsubscribe(double ticket) { onMain(() -> { core.unsubscribe(ticket); return null; }); }
        @JavascriptInterface public void start() { onMain(() -> { core.start(); return null; }); }
        @JavascriptInterface public double now() { return onMain(core::now); }
        @JavascriptInterface public String queueFill() { return onMain(core::queueFill); }
        @JavascriptInterface public void enqueue(String id, double generation, double rate, double channels, double frames,
                                                 double start, double fade, double stop, double gain, float[] samples) {
            onMain(() -> { core.enqueue(id, generation, rate, channels, frames, start, fade, stop, gain, samples); return null; });
        }
        @JavascriptInterface public void update(String id, double gain, double fade, double stop) {
            onMain(() -> { core.update(id, gain, fade, stop); return null; });
        }
        @JavascriptInterface public void cancel(String id) { onMain(() -> { core.cancel(id); return null; }); }
        @JavascriptInterface public void cancelAll() { onMain(() -> { core.cancelAll(); return null; }); }
        @JavascriptInterface public void stop() { onMain(() -> { core.stop(); return null; }); }
        @JavascriptInterface public void fault() { main.post(WebViewAudioBridge.this::close); }
        @JavascriptInterface public void close() { main.post(WebViewAudioBridge.this::close); }
    }

    private final class TrustedClient extends WebViewClient {
        private final TrustedResources resources;
        TrustedClient(TrustedResources resources) { this.resources = resources; }
        @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
            return !trusted(request.getUrl());
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
            if (trusted(request.getUrl())) {
                WebResourceResponse response = resources.load(request.getUrl());
                if (response != null) return response;
            }
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
        }
    }

    private static final class HostPort implements JavaScriptAudioBridge.Host {
        private final AndroidAudioHost host;
        HostPort(AndroidAudioHost host) { this.host = host; }
        @Override public double nowMonotonicMs() { return AndroidAudioHost.nowMonotonicMs(); }
        @Override public Runnable subscribe(JavaScriptAudioBridge.Events events) {
            return host.subscribe(event -> {
                switch (event.type) {
                    case "route-active":
                        events.routeActive(event.route.endpointId, event.route.routeId, event.route.outputId,
                            event.route.kind, event.route.generation, event.sampleRate, event.maxChannels);
                        break;
                    case "interrupted": events.interrupted(event.reason); break;
                    case "completed": events.completed(event.id); break;
                    default: events.disconnected();
                }
            });
        }
        @Override public void start() { host.start(); }
        @Override public void enqueue(NativePcm.Request request) { host.enqueue(request); }
        @Override public void updateEnvelope(String id, float gain, double fade, double stop) { host.updateEnvelope(id, gain, fade, stop); }
        @Override public void cancel(String id) { host.cancel(id); }
        @Override public void cancelAll() { host.cancelAll(); }
        @Override public long queueFillFrames() { return host.queueFillFrames(); }
        @Override public void stop() { host.stop(); }
        @Override public void close() { host.close(); }
    }

    /**
     * Bundled wrapper the trusted page runs once (e.g. as its first module) to obtain
     * {@code globalThis.nativeAudio}, an {@code AndroidAudioBridge} for
     * {@code EndpointPlaybackSession.android}. It snapshots data properties only, rejects
     * shared or resizable buffers and passes the Float32Array directly; PCM is never
     * JSON or base64 encoded.
     */
    public static final String WRAPPER_SCRIPT = String.join("\n",
        "(function(){'use strict';",
        "const native=globalThis." + INTERFACE_NAME + ";if(!native)throw Error('NATIVE_AUDIO_UNAVAILABLE');",
        "const descriptors=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,freeze=Object.freeze;",
        "const arrayBufferSize=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;",
        "const resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;",
        "const typedProto=Object.getPrototypeOf(Float32Array.prototype);",
        "const typedBuffer=Object.getOwnPropertyDescriptor(typedProto,'buffer').get;",
        "const typedTag=Object.getOwnPropertyDescriptor(typedProto,Symbol.toStringTag).get;",
        "const FIELDS='channels,fadeStartMonotonicMs,frames,gainCeiling,id,routeGeneration,sampleRate,samples,startAtMonotonicMs,stopAtMonotonicMs';",
        "const num=v=>{if(typeof v!=='number')throw Error('type');return v;};",
        "const str=v=>{if(typeof v!=='string')throw Error('type');return v;};",
        "function snapshot(input){const ds=descriptors(input),names=keys(ds);",
        " if(names.some(k=>typeof k!=='string')||names.sort().join(',')!==FIELDS)throw Error('shape');",
        " const c=Object.create(null);for(const k of names){if(!('value' in ds[k]))throw Error('accessor');c[k]=ds[k].value;}",
        " if(typedTag.call(c.samples)!=='Float32Array')throw Error('samples');",
        " const b=typedBuffer.call(c.samples);arrayBufferSize.call(b);if(resizable&&resizable.call(b))throw Error('resizable');",
        " str(c.id);for(const k of names)if(k!=='id'&&k!=='samples')num(c[k]);return c;}",
        "let listener=null;",
        "Object.defineProperty(globalThis,native.dispatchName(),{value:freeze(e=>{if(listener)listener(e);}),writable:false,configurable:false,enumerable:false});",
        "const api=freeze({",
        " subscribe(l){if(typeof l!=='function')throw Error('INVALID_LISTENER');const t=native.subscribe();listener=l;let done=false;",
        "  return()=>{if(!done){done=true;if(listener===l)listener=null;native.unsubscribe(t);}};},",
        " enqueue(r){let c;try{c=snapshot(r);}catch(_){native.fault();throw Error('INVALID_NATIVE_AUDIO_REQUEST');}",
        "  native.enqueue(c.id,c.routeGeneration,c.sampleRate,c.channels,c.frames,c.startAtMonotonicMs,c.fadeStartMonotonicMs,c.stopAtMonotonicMs,c.gainCeiling,c.samples);},",
        " updateEnvelope:(id,g,f,s)=>native.update(str(id),num(g),num(f),num(s)),",
        " cancel:id=>native.cancel(str(id)),cancelAll:()=>native.cancelAll(),",
        " nowMonotonicMs:()=>native.now(),",
        " queueFill(){const v=native.queueFill();return v==null?null:JSON.parse(v);},",
        " start:()=>native.start(),stop:()=>native.stop(),close:()=>native.close()});",
        "Object.defineProperty(globalThis,'nativeAudio',{value:api,writable:false,configurable:false,enumerable:false});",
        "})();");
}
