// Adventure Time — the textured base layer (satellite / atlas imagery under the vector overlay).
//
// A real picture of the planet needs a per-pixel inverse projection, which a 2D canvas cannot do and a
// fragment shader does in a few lines: for every pixel of the disc, undo the orthographic projection to
// get the point of the sphere under it, turn that into longitude/latitude, and look the colour up in an
// equirectangular texture. The rotation is EXACTLY the one the 2D overlay uses — the 3x3 matrix of
// `fastmap.rotationMatrix` (d3's `[λ, φ, γ]`) — so the imagery and the vector borders, tints, dots and
// pin drawn on the 2D canvas above it line up to the pixel at every zoom (tested against d3).
//
// WebGL 2 only (it gives non-power-of-two-safe mipmaps, `textureGrad` and screen derivatives without
// extensions); where it is missing `createBaseLayer` returns null and the renderer keeps the flat
// "classic" style. The texture is uploaded with mipmaps and anisotropic filtering where available, and
// the shader fixes the longitude seam (the one place `atan` jumps) so no hairline shows at ±180°.
//
// Lighting is deliberately light: a little limb darkening, a faint top-left sheen, a blue rim, and a soft
// atmosphere glow outside the limb — all in the shader, nothing per frame on the CPU but nine uniforms.

export interface BaseLayerParams {
  /** `fastmap.rotationMatrix` of the view: `u = M·v`, row-major. */
  readonly matrix: Float64Array;
  /** Globe centre and radius in CSS pixels. */
  readonly cx: number;
  readonly cy: number;
  readonly scale: number;
}

export interface BaseLayer {
  /** The layer's own canvas: place it directly under the 2D canvas, same box. */
  readonly canvas: HTMLCanvasElement;
  /** True once a texture is uploaded and the context is alive. */
  readonly ready: boolean;
  /** Uploads `source` as the planet's picture (replacing the previous one) and releases it afterwards. */
  setTexture(source: ImageBitmap | HTMLImageElement | HTMLCanvasElement): void;
  /** Largest texture side this device accepts (0 before a context exists). */
  readonly maxTextureSize: number;
  resize(width: number, height: number, dpr: number): void;
  draw(params: BaseLayerParams): void;
  /** Clears the canvas (the renderer is using the flat style). */
  clear(): void;
  /** Called when the GL context is lost; the picture must be supplied again after it returns. */
  onContextLost: (() => void) | null;
  onContextRestored: (() => void) | null;
  destroy(): void;
}

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform mat3 uM;       // the TRANSPOSE of the row-major view matrix (uploaded as-is): v = uM * u
uniform vec2 uCentre;  // device pixels, y up
uniform float uScale;  // device pixels
out vec4 outColor;
const float PI = 3.141592653589793;

// Catmull-Rom bicubic through nine bilinear taps (all with the same explicit gradients).
vec3 catmullRom(vec2 uv, vec2 size, vec2 gx, vec2 gy) {
  vec2 pos = uv * size;
  vec2 c1 = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 c12 = (c1 + w2 / w12) / size;
  vec2 c0 = (c1 - 1.0) / size;
  vec2 c3 = (c1 + 2.0) / size;
  vec3 r = vec3(0.0);
  r += textureGrad(uTex, vec2(c0.x, c0.y), gx, gy).rgb * w0.x * w0.y;
  r += textureGrad(uTex, vec2(c12.x, c0.y), gx, gy).rgb * w12.x * w0.y;
  r += textureGrad(uTex, vec2(c3.x, c0.y), gx, gy).rgb * w3.x * w0.y;
  r += textureGrad(uTex, vec2(c0.x, c12.y), gx, gy).rgb * w0.x * w12.y;
  r += textureGrad(uTex, vec2(c12.x, c12.y), gx, gy).rgb * w12.x * w12.y;
  r += textureGrad(uTex, vec2(c3.x, c12.y), gx, gy).rgb * w3.x * w12.y;
  r += textureGrad(uTex, vec2(c0.x, c3.y), gx, gy).rgb * w0.x * w3.y;
  r += textureGrad(uTex, vec2(c12.x, c3.y), gx, gy).rgb * w12.x * w3.y;
  r += textureGrad(uTex, vec2(c3.x, c3.y), gx, gy).rgb * w3.x * w3.y;
  return max(r, vec3(0.0));
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Three octaves of value noise in texel space (features from ~1 texel down to a quarter of one).
float detail(vec2 p) {
  return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.1 + 17.0) + 0.2 * vnoise(p * 4.3 + 31.0);
}

void main() {
  vec2 p = (gl_FragCoord.xy - uCentre) / uScale;          // x right, y up, in globe radii
  float r = length(p);
  float aa = max(fwidth(r), 1e-6);
  // Atmosphere: a soft blue halo outside the limb, fading out by 1.3 radii.
  float halo = exp(-(r - 1.0) * 11.0) * 0.55 * (1.0 - smoothstep(1.0, 1.32, r));
  vec4 glow = vec4(vec3(0.38, 0.64, 1.0) * halo, halo);

  // Everything below runs for every pixel (screen derivatives need the whole quad to take part); pixels
  // outside the disc are clamped onto the limb and then covered by the halo alone.
  vec2 pc = r > 1.0 ? p / r : p;
  float z = sqrt(max(0.0, 1.0 - dot(pc, pc)));
  vec3 u = vec3(z, pc.x, pc.y);                           // (depth, screen x, screen up)
  vec3 v = uM * u;                                        // the point of the sphere under this pixel
  float lng = atan(v.y, v.x);
  float lat = asin(clamp(v.z, -1.0, 1.0));
  vec2 uv = vec2(lng / (2.0 * PI) + 0.5, 0.5 - lat / PI);

  // Derivatives for mip selection, with the seam fixed: where uv.x jumps from 1 to 0 use the derivative
  // of the same coordinate shifted half a turn, which is continuous there.
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  float s2 = fract(uv.x + 0.5);
  float g2x = dFdx(s2);
  float g2y = dFdy(s2);
  if (abs(g2x) + abs(g2y) < abs(gx.x) + abs(gy.x)) { gx.x = g2x; gy.x = g2y; }
  vec2 size = vec2(textureSize(uTex, 0));
  vec2 texels = max(abs(gx), abs(gy)) * size;          // texels covered by one screen pixel
  float lod = log2(max(max(texels.x, texels.y), 1e-6));
  vec3 col;
  float mag = clamp(-lod, 0.0, 4.0);                   // how far the picture is being enlarged (octaves)
  if (lod < 0.0) {
    col = catmullRom(uv, size, gx, gy);                // enlarged: bicubic instead of blocky bilinear
    // Enlarged a lot (the 1-degree destination view): faint fractal detail so the picture does not turn
    // to mush; it only modulates brightness, anchored on the map, and fades in with the enlargement.
    float n = detail(uv * size * 2.0);
    col *= 1.0 + (n - 0.5) * 0.30 * smoothstep(0.6, 2.6, mag);
  } else {
    col = textureGrad(uTex, uv, gx, gy).rgb;
  }

  // Light touch lighting: limb darkening, a faint sheen from the upper left, a blue rim.
  float limb = mix(0.50, 1.0, pow(z, 0.45));
  float sheen = 0.9 + 0.2 * max(0.0, dot(u, normalize(vec3(0.75, -0.40, 0.52))));
  col *= limb * sheen;
  col += vec3(0.20, 0.40, 0.85) * pow(1.0 - z, 3.2) * 0.45;

  float cover = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);  // anti-aliased limb
  outColor = vec4(col * cover, cover) + glow * (1.0 - cover);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Creates the textured layer on `canvas`, or null where WebGL 2 is not available. */
export function createBaseLayer(canvas: HTMLCanvasElement): BaseLayer | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl === null) return null;

  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;
  let uM: WebGLUniformLocation | null = null;
  let uCentre: WebGLUniformLocation | null = null;
  let uScale: WebGLUniformLocation | null = null;
  let maxTexture = 0;
  let lost = false;
  let destroyed = false;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastKey = "";
  const m32 = new Float32Array(9);

  function init(context: WebGL2RenderingContext): boolean {
    const vs = compile(context, context.VERTEX_SHADER, VERTEX);
    const fs = compile(context, context.FRAGMENT_SHADER, FRAGMENT);
    if (vs === null || fs === null) return false;
    const prog = context.createProgram();
    if (prog === null) return false;
    context.attachShader(prog, vs);
    context.attachShader(prog, fs);
    context.bindAttribLocation(prog, 0, "aPos");
    context.linkProgram(prog);
    if (context.getProgramParameter(prog, context.LINK_STATUS) !== true) return false;
    program = prog;
    uM = context.getUniformLocation(prog, "uM");
    uCentre = context.getUniformLocation(prog, "uCentre");
    uScale = context.getUniformLocation(prog, "uScale");
    buffer = context.createBuffer();
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    // One big triangle covers the viewport.
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
    context.enableVertexAttribArray(0);
    context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);
    maxTexture = Number(context.getParameter(context.MAX_TEXTURE_SIZE)) || 0;
    return true;
  }

  if (!init(gl)) return null;

  const layer: BaseLayer = {
    canvas,
    get ready() {
      return !destroyed && !lost && texture !== null;
    },
    get maxTextureSize() {
      return maxTexture;
    },
    onContextLost: null,
    onContextRestored: null,
    setTexture(source) {
      if (gl === null || lost || destroyed) return;
      if (texture !== null) gl.deleteTexture(texture);
      texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic") as { TEXTURE_MAX_ANISOTROPY_EXT: number; MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
      if (aniso !== null) {
        const max = Number(gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1;
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
      }
      lastKey = "";
      // The bitmap's pixels now live on the GPU: let the CPU copy go.
      if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
    },
    resize(w, h, ratio) {
      width = Math.max(0, Math.floor(w));
      height = Math.max(0, Math.floor(h));
      dpr = Math.max(1, Math.min(2, Number.isFinite(ratio) ? ratio : 1));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      lastKey = "";
    },
    draw(p) {
      if (gl === null || lost || destroyed || program === null || texture === null || width <= 0 || height <= 0) return;
      const key = `${p.cx}|${p.cy}|${p.scale}|${canvas.width}x${canvas.height}|${p.matrix.join(",")}`;
      if (key === lastKey) return; // nothing moved: the canvas still shows this picture
      lastKey = key;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      for (let i = 0; i < 9; i += 1) m32[i] = p.matrix[i] as number;
      // Row-major upload: the shader sees the transpose, which is the inverse rotation it needs.
      gl.uniformMatrix3fv(uM, false, m32);
      gl.uniform2f(uCentre, p.cx * dpr, (height - p.cy) * dpr);
      gl.uniform1f(uScale, p.scale * dpr);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    clear() {
      if (gl === null || lost || destroyed) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      lastKey = "";
    },
    destroy() {
      destroyed = true;
      if (gl !== null) {
        if (texture !== null) gl.deleteTexture(texture);
        if (program !== null) gl.deleteProgram(program);
        if (buffer !== null) gl.deleteBuffer(buffer);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      texture = null;
      program = null;
      buffer = null;
      gl = null;
    },
  };

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
    texture = null;
    layer.onContextLost?.();
  });
  canvas.addEventListener("webglcontextrestored", () => {
    if (gl === null || destroyed) return;
    lost = false;
    lastKey = "";
    if (init(gl)) layer.onContextRestored?.();
  });
  return layer;
}
