// The paper itself, in WebGL: a finely tessellated sheet laid exactly over the
// DOM page (1 world unit = 1 CSS pixel at z = 0). A vertex shader folds it along
// the middle crease (the delivery fold) and rolls it around a moving cylinder
// (the page turn), with lighting from the desk lamp.
import {
  CanvasTexture, DoubleSide, Group, LinearFilter, Mesh, NoColorSpace, PerspectiveCamera,
  PlaneGeometry, Scene, ShaderMaterial, WebGLRenderer,
} from 'three';

const FOV = 30;
const PI = Math.PI;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const EASE = {
  inOut: (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
};
const frame = () => new Promise((r) => requestAnimationFrame(r));

const sheetVertex = /* glsl */ `
uniform vec2 uSize;
uniform float uCurlX, uAngle, uRadius, uFold, uCrease, uBend;
varying vec2 vUv; varying vec3 vNormal; varying float vShade;
const float PI = 3.141592653589793;
void main(){
  vec3 p = position;
  vec3 N = vec3(0., 0., 1.);
  float shade = 1.;
  if (uFold > .0001 && p.y < uCrease) {
    float rel = uCrease - p.y, c = cos(uFold), s = sin(uFold);
    p.y = uCrease - rel*c;
    p.z = -rel*s;
    N = vec3(0., -s, c);
    shade *= 1. - .16*s*exp(-rel/(uSize.y*.025));
  }
  p.z += uBend * sin(PI*clamp(p.x/uSize.x, 0., 1.));
  vec2 n = vec2(cos(uAngle), -sin(uAngle));
  float d = dot(p.xy - vec2(uCurlX, 0.), n);
  if (d > 0.) {
    vec2 base = p.xy - d*n;
    float R = uRadius;
    if (d < PI*R) {
      float th = d/R;
      p.xy = base + n*(R*sin(th));
      p.z += R*(1. - cos(th));
      N = vec3(-n*sin(th), cos(th));
    } else {
      p.xy = base - n*(d - PI*R);
      p.z += 2.*R;
      N = vec3(0., 0., -1.);
    }
  }
  vUv = uv;
  vNormal = normalize(normalMatrix * N);
  vShade = shade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
}`;

const sheetFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex; uniform vec3 uPaper; uniform float uOpacity;
varying vec2 vUv; varying vec3 vNormal; varying float vShade;
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
void main(){
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(vec3(-.35, .45, 1.));
  float light = .70 + .345*max(dot(N, L), 0.);   // == 1.0 when lying flat, so it matches the DOM
  vec3 col;
  if (gl_FrontFacing) {
    col = texture2D(uTex, vUv).rgb;
  } else {
    vec3 through = texture2D(uTex, vec2(1. - vUv.x, vUv.y)).rgb;   // newsprint show-through
    col = mix(uPaper*.985, through, .09);
  }
  col *= .99 + .02*hash(floor(vUv*vec2(1400., 1800.)));
  vec3 H = normalize(L + vec3(0., 0., 1.));
  col += pow(max(dot(N, H), 0.), 120.) * .08;
  col *= light * vShade;
  gl_FragColor = vec4(col, uOpacity);
}`;

const shadowVertex = /* glsl */ `
varying vec2 vPos;
void main(){ vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;

const shadowFragment = /* glsl */ `
precision highp float;
uniform vec2 uSize; uniform float uMode, uCurlX, uAngle, uRadius, uStrength, uBlur;
varying vec2 vPos;
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.)) + min(max(d.x, d.y), 0.); }
void main(){
  float a;
  if (uMode < .5) {
    vec2 n = vec2(cos(uAngle), -sin(uAngle));
    float d = dot(vPos - vec2(uCurlX, 0.), n);
    float inside = step(0., vPos.x)*step(vPos.x, uSize.x)*step(0., vPos.y)*step(vPos.y, uSize.y);
    a = inside * smoothstep(-2., uRadius*.3, d) * (1. - smoothstep(0., 3.1416*uRadius*1.6 + 40., d)) * .45;
  } else {
    float sd = sdBox(vPos - uSize*.5 + vec2(0., 14.), uSize*.5 - vec2(uBlur*.15));
    a = (1. - smoothstep(-uBlur*.5, uBlur, sd)) * .6;
  }
  gl_FragColor = vec4(.06, .035, .015, a*uStrength);
}`;

export class PaperOverlay {
  static create(canvas) {
    try {
      return new PaperOverlay(canvas);
    } catch (err) {
      console.warn('WebGL paper unavailable', err);
      return null;
    }
  }

  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(FOV, 1, 10, 20000);
    this.group = new Group();
    this.scene.add(this.group);
    this.progress = 0;

    this.sheetUniforms = {
      uTex: { value: null }, uPaper: { value: [243 / 255, 238 / 255, 226 / 255] }, uOpacity: { value: 1 },
      uSize: { value: [1, 1] }, uCurlX: { value: 1e5 }, uAngle: { value: 0 }, uRadius: { value: 40 },
      uFold: { value: 0 }, uCrease: { value: 0 }, uBend: { value: 0 },
    };
    this.sheetMat = new ShaderMaterial({
      vertexShader: sheetVertex, fragmentShader: sheetFragment, uniforms: this.sheetUniforms,
      side: DoubleSide, transparent: true,
    });
    this.shadowUniforms = {
      uSize: { value: [1, 1] }, uMode: { value: 0 }, uCurlX: { value: 1e5 }, uAngle: { value: 0 },
      uRadius: { value: 40 }, uStrength: { value: 0 }, uBlur: { value: 60 },
    };
    this.shadowMat = new ShaderMaterial({
      vertexShader: shadowVertex, fragmentShader: shadowFragment, uniforms: this.shadowUniforms,
      transparent: true, depthTest: false, depthWrite: false,
    });

    this.resize();
    addEventListener('resize', () => this.resize());
    canvas.style.visibility = 'hidden';
  }

  resize() {
    this.vw = innerWidth;
    this.vh = innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(this.vw, this.vh, false);
    this.camera.aspect = this.vw / this.vh;
    this.camera.position.set(0, 0, this.vh / 2 / Math.tan((FOV * PI) / 360));
    this.camera.updateProjectionMatrix();
  }

  _layout(rect) {
    const W = rect.width, H = rect.height;
    if (!this.sheet || this.W !== W || this.H !== H) {
      this.sheet?.geometry.dispose();
      this.shadow?.geometry.dispose();
      if (this.sheet) this.group.remove(this.sheet);
      if (this.shadow) this.scene.remove(this.shadow);
      const sheetGeo = new PlaneGeometry(W, H, Math.min(180, Math.ceil(W / 7)), Math.min(200, Math.ceil(H / 7)));
      sheetGeo.translate(W / 2, H / 2, 0);
      this.sheet = new Mesh(sheetGeo, this.sheetMat);
      this.sheet.frustumCulled = false;
      this.group.add(this.sheet);
      const pad = 160;
      const shadowGeo = new PlaneGeometry(W + pad * 2, H + pad * 2);
      shadowGeo.translate(W / 2, H / 2, 0);
      this.shadow = new Mesh(shadowGeo, this.shadowMat);
      this.shadow.renderOrder = -1;
      this.shadow.frustumCulled = false;
      this.scene.add(this.shadow);
      this.W = W;
      this.H = H;
    }
    this.sheetUniforms.uSize.value = [W, H];
    this.shadowUniforms.uSize.value = [W, H];
    this.baseX = rect.left + W / 2 - this.vw / 2;
    this.baseY = this.vh / 2 - (rect.top + H / 2);
    this.group.position.set(this.baseX, this.baseY, 0);
    this.group.rotation.set(0, 0, 0);
    this.sheet.position.set(-W / 2, -H / 2, 0);
    this.shadow.position.set(this.baseX - W / 2, this.baseY - H / 2, 0);
  }

  _texture(canvas) {
    this.texture?.dispose();
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = NoColorSpace; // sample raw sRGB so the print matches the DOM exactly
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.texture = tex;
    this.sheetUniforms.uTex.value = tex;
  }

  _curl(p) {
    const { W, H } = this;
    const angle = lerp(.26, .05, p);
    const radius = W * (.06 + .07 * Math.sin(PI * p)) + 18;
    const end = -(PI * radius + H * Math.sin(angle)) / Math.cos(angle) - 6;
    const x = lerp(W + 2, end, p);
    const s = this.sheetUniforms, sh = this.shadowUniforms;
    s.uCurlX.value = sh.uCurlX.value = x;
    s.uAngle.value = sh.uAngle.value = angle;
    s.uRadius.value = sh.uRadius.value = radius;
    s.uOpacity.value = 1 - seg(p, .84, 1);
    sh.uMode.value = 0;
    sh.uStrength.value = Math.sqrt(Math.sin(PI * clamp01(p)));
  }

  _render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Lay a printed page over the DOM at turn progress `from` (0 = flat, 1 = turned away). */
  async beginTurn(rect, canvas, from) {
    this._layout(rect);
    this._texture(canvas);
    this.sheetUniforms.uFold.value = 0;
    this.sheetUniforms.uBend.value = 0;
    this.progress = from;
    this._curl(from);
    this._render();
    this.canvas.style.visibility = 'visible';
    await frame();
    await frame();
  }

  setProgress(p) {
    this.progress = clamp01(p);
    this._curl(this.progress);
    this._render();
  }

  animateTo(target, { easing = 'inOut', duration } = {}) {
    const start = this.progress;
    const dur = duration ?? 180 + 880 * Math.abs(target - start);
    const ease = EASE[easing];
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const t = clamp01((now - t0) / dur);
        this.setProgress(lerp(start, target, ease(t)));
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  /** The morning delivery: a folded paper flies in, unfolds, and lands on the page. */
  intro(rect, canvas, { duration = 2100 } = {}) {
    this._layout(rect);
    this._texture(canvas);
    this._curl(0);
    const s = this.sheetUniforms, sh = this.shadowUniforms;
    s.uCrease.value = this.H / 2;
    s.uOpacity.value = 0;
    sh.uMode.value = 1;
    this.canvas.style.visibility = 'visible';
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const t = clamp01((now - t0) / duration);
        const fly = EASE.out(seg(t, 0, .62));
        const settle = EASE.out(seg(t, .04, .88));
        const unfold = EASE.inOut(seg(t, .30, .86));
        this.group.position.set(this.baseX, this.baseY + lerp(-this.vh * .18, 0, fly), lerp(-1500, 0, fly));
        this.group.rotation.set(lerp(-.9, 0, settle), lerp(.2, 0, fly), lerp(-.24, 0, settle));
        s.uFold.value = lerp(PI * .985, 0, unfold);
        s.uBend.value = Math.sin(PI * seg(t, .22, .96)) * 22;
        s.uOpacity.value = seg(t, 0, .12);
        sh.uStrength.value = seg(t, .25, .9) * .9;
        sh.uBlur.value = lerp(140, 26, seg(t, .3, 1));
        this._render();
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  end() {
    this.canvas.style.visibility = 'hidden';
    this.shadowUniforms.uStrength.value = 0;
    this.renderer.clear();
  }
}
