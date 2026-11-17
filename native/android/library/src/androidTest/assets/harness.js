// Bundled test harness: records bridge events and plays a short synthetic tone.
'use strict';
var events = [], results = {};
function sub() { results.unsubscribe = nativeAudio.subscribe(function (e) { events.push(e); }); return 'subscribed'; }
function routeOf() { for (var i = events.length - 1; i >= 0; i--) if (events[i].type === 'route-active') return events[i]; return null; }
function playTone(id, ms) {
  var r = routeOf(), rate = r.sampleRate, ch = r.maxChannels, frames = Math.round(rate * ms / 1000);
  var samples = new Float32Array(frames * ch);
  for (var f = 0; f < frames; f++) for (var c = 0; c < ch; c++) samples[f * ch + c] = 0.1 * Math.sin(2 * Math.PI * 440 * f / rate);
  var start = nativeAudio.nowMonotonicMs() + 150;
  nativeAudio.enqueue({id: id, routeGeneration: r.route.generation, samples: samples, sampleRate: rate, channels: ch,
    frames: frames, startAtMonotonicMs: start, gainCeiling: 0.5, fadeStartMonotonicMs: start + ms - 20, stopAtMonotonicMs: start + ms});
  var fill = nativeAudio.queueFill();
  return JSON.stringify({frames: frames, fill: fill});
}
function attempt(fn) { try { var v = fn(); return 'ok:' + JSON.stringify(v === undefined ? null : v); } catch (e) { return 'error:' + String(e && e.message); } }
