// Confessional Booth — live background compositor (WebGL2, zero dependencies).
//
// WHAT THIS IS. It separates you from what is behind you and puts something else there: flat
// broadcast green (so PepStudio — or any editor — can key you over gameplay later), flat blue,
// a still image, or a blur of your own room.
//
// HOW IT DECIDES WHAT IS "BEHIND YOU". Two mattes, because they fail in opposite situations and
// between them they cover a real room:
//   * CHROMA  — you have a green/blue screen. Pixels near the key colour become background.
//               Classic, crisp, and it does not care whether you move the camera.
//   * ROOM    — you don't. Step out of frame, capture the empty room once, step back in; any
//               pixel that still matches the empty room is background. Perfect for the locked-off
//               tripod a confessional is shot on, and it needs no backdrop at all. It does assume
//               the camera and the lighting hold still — move either and you re-capture.
//
// WHY WEBGL. A 1080p frame is two million pixels and the matte is per-pixel, thirty times a
// second. In JavaScript that is ~60ms a frame — unusable. On the GPU it is a fragment shader and
// costs nothing measurable. There is no library here: ~120 lines of GLSL and the plumbing to feed
// it, so nothing is downloaded and nothing leaves the machine.
'use strict';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCam;      // live camera frame (mipmapped, so we can sample a blurred LOD)
uniform sampler2D uBack;     // background image, or a 1x1 pixel of flat colour
uniform sampler2D uRef;      // captured empty-room reference
uniform int   uMatte;        // 0 = none (passthrough) · 1 = chroma key · 2 = room difference
uniform int   uBlurBack;     // 1 = background is a blur of the camera itself
uniform vec3  uKey;          // key colour
uniform float uTol;          // how far from the key still counts as background
uniform float uSoft;         // width of the soft edge
uniform float uSpill;        // 0..1 how hard to pull the key colour out of hair/shoulders
uniform float uBlurLod;      // mip level used for the blurred background
uniform vec2  uBackScale;    // cover-fit of the background image
uniform vec2  uBackOffset;

in vec2 vUv;
out vec4 fragColor;

// Chrominance only. Luma is thrown away on purpose: a green screen is never evenly lit, and
// comparing hue instead of brightness is what lets one tolerance survive a hot spot and a shadow
// on the same backdrop.
vec2 chroma(vec3 c) {
  return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b,
               0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}

void main() {
  vec3 cam = texture(uCam, vUv).rgb;

  // alpha: 1 = keep the camera (you), 0 = replace it (background).
  float alpha = 1.0;
  if (uMatte == 1) {
    alpha = smoothstep(uTol, uTol + uSoft, distance(chroma(cam), chroma(uKey)));
  } else if (uMatte == 2) {
    vec3 ref = texture(uRef, vUv).rgb;
    // Weighted toward chrominance again, but room matting needs some luma or a person in dark
    // clothes against a dark wall disappears.
    float dc = distance(chroma(cam), chroma(ref));
    float dl = abs(dot(cam - ref, vec3(0.299, 0.587, 0.114)));
    alpha = smoothstep(uTol, uTol + uSoft, max(dc, dl * 0.65));
  }

  // Spill suppression: a green screen bounces green onto hair and shoulders, which no matte can
  // remove because those pixels really are partly green. Pull the key channel back toward its
  // neighbours instead, so the edge stops glowing.
  vec3 fg = cam;
  if (uMatte == 1 && uSpill > 0.0) {
    if (uKey.g >= uKey.r && uKey.g >= uKey.b) {
      float cap = mix(cam.g, max(cam.r, cam.b), uSpill);
      fg.g = min(cam.g, max(cap, min(cam.r, cam.b)));
    } else if (uKey.b >= uKey.r && uKey.b >= uKey.g) {
      float cap = mix(cam.b, max(cam.r, cam.g), uSpill);
      fg.b = min(cam.b, max(cap, min(cam.r, cam.g)));
    }
  }

  vec3 back = (uBlurBack == 1)
    ? textureLod(uCam, vUv, uBlurLod).rgb
    : texture(uBack, vUv * uBackScale + uBackOffset).rgb;

  fragColor = vec4(mix(back, fg, alpha), 1.0);
}`;

// Broadcast chroma green / blue. Not #00ff00: pure green clips in camera and in h264 chroma
// subsampling, which is exactly what makes a key crunchy at the edges.
export const KEY_GREEN = '#00b140';
export const KEY_BLUE = '#0047bb';

const hexToRgb = (hex) => {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export class Background {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.mode = 'off';            // off · green · blue · image · blur
    this.matte = 'chroma';        // chroma · room
    this.key = KEY_GREEN;
    this.tol = 0.085;
    this.soft = 0.075;
    this.spill = 0.6;
    this.image = null;            // HTMLImageElement
    this.hasRef = false;
    this.raf = 0;
    this.gl = null;
    this.ready = false;
    this._capture = null;
  }

  // WebGL2 or nothing: we refuse to silently fall back to a CPU matte that would drop the
  // preview to single-digit frame rates mid-take.
  init() {
    if (this.ready) return true;
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, desynchronized: true,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    this.prog = prog;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // One oversized triangle covers the viewport with no seam down the middle.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.texCam = this._tex(gl.LINEAR);
    this._mips = false;
    this.texBack = this._tex(gl.LINEAR);
    this.texRef = this._tex(gl.LINEAR);
    // 1x1 placeholders so the first draw is valid before any frame or image has arrived.
    for (const t of [this.texBack, this.texRef]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    }

    this.u = {};
    for (const n of ['uCam', 'uBack', 'uRef', 'uMatte', 'uBlurBack', 'uKey', 'uTol', 'uSoft', 'uSpill', 'uBlurLod', 'uBackScale', 'uBackOffset']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    gl.uniform1i(this.u.uCam, 0);
    gl.uniform1i(this.u.uBack, 1);
    gl.uniform1i(this.u.uRef, 2);
    this.ready = true;
    return true;
  }

  _tex(min) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  get active() { return this.mode !== 'off'; }

  // Flat-colour background: upload a single pixel rather than a full-frame texture.
  _solid(hex) {
    const gl = this.gl;
    const [r, g, b] = hexToRgb(hex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texBack);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255]));
    gl.uniform2f(this.u.uBackScale, 1, 1);
    gl.uniform2f(this.u.uBackOffset, 0, 0);
  }

  // Cover-fit a still so it fills the frame without distorting it.
  _uploadImage() {
    const gl = this.gl;
    const img = this.image;
    if (!img || !img.naturalWidth) return this._solid('#111114');
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texBack);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const ca = this.canvas.width / Math.max(1, this.canvas.height);
    const ia = img.naturalWidth / img.naturalHeight;
    const sx = ia > ca ? ca / ia : 1;
    const sy = ia > ca ? 1 : ia / ca;
    gl.uniform2f(this.u.uBackScale, sx, sy);
    gl.uniform2f(this.u.uBackOffset, (1 - sx) / 2, (1 - sy) / 2);
  }

  setImage(img) { this.image = img; if (this.ready && this.mode === 'image') this._uploadImage(); }

  // Freeze the current frame as the "empty room" the matte compares against.
  captureReference() {
    if (!this.init() || !this.video.videoWidth) return false;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texRef);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    this.hasRef = true;
    return true;
  }

  // Average the colour in a small patch around a click — one pixel is noise, and the user is
  // pointing at "that green", not at a specific sample.
  sampleAt(u, v, radius = 6) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw) return null;
    const c = document.createElement('canvas');
    c.width = radius * 2; c.height = radius * 2;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video,
      Math.max(0, Math.min(vw - radius * 2, Math.round(u * vw) - radius)),
      Math.max(0, Math.min(vh - radius * 2, Math.round(v * vh) - radius)),
      radius * 2, radius * 2, 0, 0, radius * 2, radius * 2);
    const d = ctx.getImageData(0, 0, radius * 2, radius * 2).data;
    let r = 0; let g = 0; let b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    const hex = (x) => Math.round(x / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  start() {
    if (!this.init()) return false;
    if (this.raf) return true;
    const gl = this.gl;
    const draw = () => {
      this.raf = requestAnimationFrame(draw);
      const v = this.video;
      if (!v.videoWidth || v.readyState < 2) return;
      if (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight) {
        this.canvas.width = v.videoWidth;
        this.canvas.height = v.videoHeight;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        if (this.mode === 'image') this._uploadImage();
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texCam);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      // The blurred background is just a high mip of the camera — a real separable blur would be
      // two extra passes for a result nobody can tell apart at this radius. The filter is only
      // flipped to a mipmapped one once the levels actually exist (see the note at texCam).
      const wantMips = this.mode === 'blur';
      if (wantMips) gl.generateMipmap(gl.TEXTURE_2D);
      if (wantMips !== this._mips) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, wantMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        this._mips = wantMips;
      }
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texBack);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texRef);

      const matte = this.mode === 'off' ? 0 : (this.matte === 'room' ? (this.hasRef ? 2 : 0) : 1);
      gl.uniform1i(this.u.uMatte, matte);
      gl.uniform1i(this.u.uBlurBack, this.mode === 'blur' ? 1 : 0);
      gl.uniform3fv(this.u.uKey, hexToRgb(this.key));
      gl.uniform1f(this.u.uTol, this.tol);
      gl.uniform1f(this.u.uSoft, this.soft);
      gl.uniform1f(this.u.uSpill, this.matte === 'chroma' ? this.spill : 0);
      gl.uniform1f(this.u.uBlurLod, 4.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    draw();
    return true;
  }

  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  setMode(mode) {
    this.mode = mode;
    if (!this.active) { this.stop(); return true; }
    if (!this.init()) { this.mode = 'off'; return false; }
    if (mode === 'green') this._solid(KEY_GREEN);
    else if (mode === 'blue') this._solid(KEY_BLUE);
    else if (mode === 'image') this._uploadImage();
    return this.start();
  }

  // The stream MediaRecorder gets while a background is on: composited video off the canvas,
  // plus the microphone track straight from the camera stream (never re-encoded here).
  stream(audioTrack, fps = 30) {
    if (!this._capture) this._capture = this.canvas.captureStream(fps);
    const tracks = [...this._capture.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
    return new MediaStream(tracks);
  }
}
