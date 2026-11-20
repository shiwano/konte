import { KonteError } from "../../errors.js";
import type { ColorString } from "../adapters/local.js";
import { errorOverlayJs } from "./animate.js";

// The page script behind `<Video chromaKey>`. A capture swaps its `__render_frame__` image in for
// the <video> inside `texImage2D` and dispatches `hf-seek` again once the frame is in. No
// animation-frame loop: the capture calibrates a page running one as slow to settle.
// The shader keys green; any other backdrop is turned about the grey axis until its hue is green's.
// Every keyed clip on a page draws through one WebGL context and copies the result to its own 2D
// canvas: a browser caps live WebGL contexts per page well below a reel's clip count.

const FRAGMENT_SHADER = `precision highp float;
varying vec2 uv;
uniform sampler2D tex;
uniform vec2 px;
uniform vec3 key;
uniform mat3 rot;
uniform mat3 back;
const float SIM = 0.15;
const float SMOOTH = 0.45;
const float CHOKE = 0.6;
const float RING = 6.0;
vec3 tap(vec2 o) {
  return rot * texture2D(tex, uv + o).rgb;
}
float keyA(vec3 c, vec3 bg) {
  float k = (c.g - max(c.r, c.b)) / max(bg.g - max(bg.r, bg.b), 0.05);
  return 1.0 - smoothstep(SIM, SIM + SMOOTH, k);
}
vec3 localBackdrop() {
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int r = 1; r <= 2; r++) for (int i = 0; i < 12; i++) {
    float ang = float(i) * 0.5235988 + float(r) * 0.26;
    vec3 s = tap(vec2(cos(ang), sin(ang)) * px * float(r) * RING);
    if (keyA(s, key) < 0.02) { acc += s; n += 1.0; }
  }
  return n > 0.0 ? acc / n : key;
}
void main() {
  vec3 c = tap(vec2(0.0));
  vec3 bg = localBackdrop();
  float mn = 1.0, sum = 0.0, wsum = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    float s = keyA(tap(vec2(float(x), float(y)) * px), bg);
    float w = (x == 0 && y == 0) ? 4.0 : ((x == 0 || y == 0) ? 2.0 : 1.0);
    mn = min(mn, s);
    sum += s * w;
    wsum += w;
  }
  float blur = sum / wsum;
  float a = smoothstep(0.0, 1.0, mix(blur, min(blur, mn + 0.5), CHOKE));
  float f = min(1.0 - a, max(0.0, (c.g - c.b) / max(bg.g - bg.b, 0.05)));
  vec3 col = c - f * bg;
  float m = (col.r + col.b) * 0.5;
  if (col.g > m) col.g = m;
  gl_FragColor = vec4(clamp(back * col, 0.0, a), a);
}`;

const VERTEX_SHADER =
  "attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }";

const RUNTIME = `function (videoId, canvasId, vs, fs, rot, base, fail) {
  // Clips whose ids collide take the elements in document order, each script the first left.
  var claim = function (id) {
    var all = document.querySelectorAll("#" + CSS.escape(id));
    for (var i = 0; i < all.length; i++) {
      if (!all[i].hasAttribute("data-konte-keyed")) {
        all[i].setAttribute("data-konte-keyed", "");
        return all[i];
      }
    }
    return null;
  };
  var video = claim(videoId);
  var canvas = claim(canvasId);
  if (!video || !canvas) return;
  var layer = canvas.parentElement;
  var shown = function () {
    return !layer || getComputedStyle(layer).visibility !== "hidden";
  };
  var out = canvas.getContext("2d");
  var failed = false;
  var unkeyed = function (msg) {
    if (failed) return;
    failed = true;
    video.style.opacity = "";
    fail(msg);
  };
  var shared = function () {
    var s = window.__konteChromaKey;
    if (s && !s.gl.isContextLost()) return s;
    var surface = document.createElement("canvas");
    var gl = surface.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL is unavailable in this browser");
    var compile = function (type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 36;
    s = {
      surface: surface,
      gl: gl,
      px: gl.getUniformLocation(prog, "px"),
      key: gl.getUniformLocation(prog, "key"),
      rot: gl.getUniformLocation(prog, "rot"),
      back: gl.getUniformLocation(prog, "back"),
      probe: probe.getContext("2d", { willReadFrequently: true }),
    };
    window.__konteChromaKey = s;
    return s;
  };
  var columns = [rot[0], rot[3], rot[6], rot[1], rot[4], rot[7], rot[2], rot[5], rot[8]];
  var median = function (xs) {
    xs.sort(function (a, b) { return a - b; });
    return xs[xs.length >> 1] / 255;
  };
  // The backdrop's colour in this frame alone, turned to green: the median of its clearly green
  // pixels, else the declared colour.
  var keyOf = function (probe, source) {
    try {
      probe.drawImage(source, 0, 0, 64, 36);
      var d = probe.getImageData(0, 0, 64, 36).data;
      var r = [], g = [], b = [];
      for (var i = 0; i < d.length; i += 4) {
        var R = rot[0] * d[i] + rot[1] * d[i + 1] + rot[2] * d[i + 2];
        var G = rot[3] * d[i] + rot[4] * d[i + 1] + rot[5] * d[i + 2];
        var B = rot[6] * d[i] + rot[7] * d[i + 1] + rot[8] * d[i + 2];
        if (G - Math.max(R, B) > 48) { r.push(R); g.push(G); b.push(B); }
      }
      if (g.length >= 32) return [median(r), median(g), median(b)];
    } catch (e) {}
    return base;
  };
  // A capture paints the frame as an <img> beside the hidden <video>; a browser plays the <video>.
  var frameOf = function () {
    var next = video.nextElementSibling;
    if (next && next.classList.contains("__render_frame__")) {
      return next.complete && next.naturalWidth > 0 ? next : null;
    }
    return video.readyState >= 2 ? video : null;
  };
  var draw = function () {
    if (failed || !out || !shown()) return;
    var frame = frameOf();
    if (!frame) return;
    var s;
    try {
      s = shared();
    } catch (err) {
      unkeyed(err && err.message ? err.message : String(err));
      return;
    }
    var gl = s.gl;
    var w = frame === video ? video.videoWidth : frame.naturalWidth;
    var h = frame === video ? video.videoHeight : frame.naturalHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (s.surface.width !== w || s.surface.height !== h) { s.surface.width = w; s.surface.height = h; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.uniform2f(s.px, 1 / w, 1 / h);
    gl.uniform3fv(s.key, keyOf(s.probe, frame));
    gl.uniformMatrix3fv(s.rot, false, columns);
    gl.uniformMatrix3fv(s.back, false, rot);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    out.clearRect(0, 0, w, h);
    out.drawImage(s.surface, 0, 0);
  };
  if (!out) {
    unkeyed("a 2D canvas is unavailable in this browser");
    return;
  }
  if (layer) {
    var wasShown = shown();
    new MutationObserver(function () {
      var now = shown();
      if (now && !wasShown) draw();
      wasShown = now;
    }).observe(layer, { attributes: true, attributeFilter: ["style"] });
  }
  window.addEventListener("hf-seek", draw);
  video.addEventListener("loadeddata", draw);
  video.addEventListener("canplay", draw);
  video.addEventListener("seeked", draw);
  if (typeof video.requestVideoFrameCallback === "function") {
    var onFrame = function () { draw(); video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }
  draw();
}`;

export const DEFAULT_BACKDROP: ColorString = "#00ff00";

export function backdropColor(color: string, label: string): ColorString {
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${label} chromaKey="${color}" is not a colour — pass a hex string like #RRGGBB.`,
    );
  }
  return color as ColorString;
}

function rgbOf(color: ColorString): [number, number, number] {
  let hex = color.slice(1);
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

// The row-major rotation about the grey axis that carries `color`'s hue onto green's; its
// transpose turns it back.
export function hueRotationToGreen(color: ColorString, label: string): number[] {
  const [r, g, b] = rgbOf(color);
  const x = r - (g + b) / 2;
  const y = (Math.sqrt(3) / 2) * (g - b);
  if (Math.hypot(x, y) < 0.15) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${label} chromaKey="${color}" is too close to grey to key — pass the backdrop's own saturated colour.`,
    );
  }
  const theta = (2 * Math.PI) / 3 - Math.atan2(y, x);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const u = 1 / Math.sqrt(3);
  const t = (1 - cos) * u * u;
  return [
    cos + t,
    t - sin * u,
    t + sin * u,
    t + sin * u,
    cos + t,
    t - sin * u,
    t - sin * u,
    t + sin * u,
    cos + t,
  ];
}

export function chromaKeyScript(
  videoId: string,
  canvasId: string,
  backdrop: ColorString,
  shotId: string,
  label: string,
): string {
  const rot = hueRotationToGreen(backdrop, label);
  const [r, g, b] = rgbOf(backdrop);
  const key = [0, 3, 6].map((i) => rot[i]! * r + rot[i + 1]! * g + rot[i + 2]! * b);
  const args = [videoId, canvasId, VERTEX_SHADER, FRAGMENT_SHADER, rot, key].map((a) =>
    JSON.stringify(a).replace(/</g, "\\u003c"),
  );
  const fail = `function (msg) {
  msg = ${JSON.stringify(`${label} chromaKey`)} + " (#" + ${args[1]} + ") shows its take unkeyed: " + msg;
  console.error("[konte] " + msg);
  ${errorOverlayJs(shotId, "data-konte-chroma-key-error", "<Video chromaKey> could not key")}
}`;
  return `(${RUNTIME})(${args.join(", ")}, ${fail});`;
}
