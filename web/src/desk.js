// The reading desk: lamp-lit walnut planks with dust drifting through the light.
import {
  AdditiveBlending, BufferGeometry, Float32BufferAttribute, Mesh, OrthographicCamera,
  PlaneGeometry, Points, Scene, ShaderMaterial, WebGLRenderer,
} from 'three';

const NOISE = /* glsl */ `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x), mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x), u.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return v; }
`;

const LAMP = '-.40, .32';

const deskFragment = /* glsl */ `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform float uLamp; uniform vec2 uParallax;
${NOISE}
void main(){
  vec2 uv = (gl_FragCoord.xy - .5*uRes) / uRes.y;
  vec2 p = uv + uParallax*.012;
  float pw = .42;
  float row = floor(p.y/pw);
  float fy = fract(p.y/pw);
  vec2 q = vec2(p.x*.9 + hash(vec2(row, 3.1))*13., fy*pw);
  float warp = fbm(vec2(q.x*1.6, q.y*6.) + row);
  float grain = fbm(vec2(q.x*2.2, q.y*44. + warp*3.));
  float fine = noise(vec2(q.x*70., q.y*500.));
  float figure = smoothstep(.2, .9, sin(q.y*38. + warp*9. + q.x*.6)*.5 + .5);
  vec3 dark = vec3(.105,.058,.030), mid = vec3(.255,.140,.070), hi = vec3(.420,.245,.125);
  vec3 col = mix(dark, mid, grain);
  col = mix(col, hi, figure*.30*warp);
  col *= .84 + .24*hash(vec2(row, 7.7));
  col *= .93 + .07*fine;
  float seam = smoothstep(0., 2.2/uRes.y, min(fy, 1.-fy)*pw);
  col *= mix(.38, 1., seam);

  vec2 lamp = vec2(${LAMP});
  float d = length((uv - lamp)*vec2(.82, 1.));
  float pool = exp(-d*d*2.1);
  vec3 warm = vec3(1., .80, .56);
  vec3 lit = col * (.13 + 1.6*pool*uLamp) * warm;
  lit += warm * pow(pool, 5.) * .06 * uLamp * (grain + .2);
  lit *= mix(.28, 1., smoothstep(1.3, .22, length(uv*vec2(.8, 1.))));
  lit += (hash(gl_FragCoord.xy + fract(uTime*.37)*100.) - .5) * .014;
  gl_FragColor = vec4(lit, 1.);
}`;

const dustVertex = /* glsl */ `
uniform float uTime; uniform vec2 uParallax; uniform float uAspect; uniform float uDpr; uniform float uLamp;
attribute vec3 seed;
varying float vA;
void main(){
  vec3 p = position;
  float t = uTime * (.4 + seed.y);
  p.x += sin(t*.21 + seed.x*6.28)*.06 + uTime*.004*(seed.y+.2);
  p.y += cos(t*.17 + seed.x*3.1)*.05 + sin(uTime*.05 + seed.z)*.02;
  p.x = mod(p.x + 1.2, 2.4) - 1.2;
  p.xy += uParallax * (.015 + p.z*.05);
  gl_Position = vec4(p.x/(.5*uAspect), p.y/.5, 0., 1.);
  vec2 lamp = vec2(${LAMP});
  float d = length(p.xy - lamp);
  float twinkle = .45 + .55*(sin(t*1.7 + seed.x*40.)*.5 + .5);
  vA = exp(-d*d*2.6) * uLamp * twinkle;
  gl_PointSize = (1. + seed.z*3.4) * (.55 + p.z) * uDpr;
}`;

const dustFragment = /* glsl */ `
precision mediump float;
varying float vA;
void main(){
  float r = length(gl_PointCoord - .5);
  gl_FragColor = vec4(1., .86, .62, smoothstep(.5, 0., r) * vA * .6);
}`;

export class Desk {
  static create(canvas, opts) {
    try {
      return new Desk(canvas, opts);
    } catch (err) {
      console.warn('WebGL desk unavailable', err);
      document.documentElement.classList.add('no-webgl');
      return null;
    }
  }

  constructor(canvas, { reduced = false } = {}) {
    this.reduced = reduced;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0 };
    this.lamp = reduced ? 1 : 0;

    this.deskMat = new ShaderMaterial({
      fragmentShader: deskFragment,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }',
      uniforms: { uRes: { value: [1, 1] }, uTime: { value: 0 }, uLamp: { value: this.lamp }, uParallax: { value: [0, 0] } },
      depthWrite: false,
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.deskMat));

    const count = matchMedia('(max-width: 720px)').matches ? 110 : 260;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos.set([Math.random() * 2.4 - 1.2, Math.random() * 1.1 - .55, Math.random()], i * 3);
      seed.set([Math.random(), Math.random(), Math.random()], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('seed', new Float32BufferAttribute(seed, 3));
    this.dustMat = new ShaderMaterial({
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      uniforms: { uTime: { value: 0 }, uParallax: { value: [0, 0] }, uAspect: { value: 1 }, uDpr: { value: 1 }, uLamp: { value: this.lamp } },
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    const dust = new Points(geo, this.dustMat);
    dust.frustumCulled = false;
    this.scene.add(dust);

    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('pointermove', (e) => {
      this.parallax.tx = (e.clientX / innerWidth - .5) * 2;
      this.parallax.ty = -(e.clientY / innerHeight - .5) * 2;
    }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this._loop(); });

    this.start = performance.now();
    this.last = 0;
    this._loop = this._loop.bind(this);
    this._loop();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.deskMat.uniforms.uRes.value = [innerWidth * dpr, innerHeight * dpr];
    this.dustMat.uniforms.uAspect.value = innerWidth / innerHeight;
    this.dustMat.uniforms.uDpr.value = dpr;
    if (this.reduced) this._draw(0);
  }

  /** Switch the lamp on with a filament flicker. Resolves once it is steady. */
  lampOn() {
    if (this.reduced) return Promise.resolve();
    const keys = [[0, 0], [.10, .5], [.16, .08], [.28, .72], [.34, .35], [.52, .92], [.62, .8], [1, 1]];
    const t0 = performance.now(), dur = 1100;
    return new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        let k = 1;
        while (k < keys.length - 1 && keys[k][0] < t) k++;
        const [ta, va] = keys[k - 1], [tb, vb] = keys[k];
        this.lamp = va + (vb - va) * ((t - ta) / (tb - ta || 1));
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  _draw(time) {
    const p = this.parallax;
    p.x += (p.tx - p.x) * .05;
    p.y += (p.ty - p.y) * .05;
    for (const m of [this.deskMat, this.dustMat]) {
      m.uniforms.uTime.value = time;
      m.uniforms.uLamp.value = this.lamp;
      m.uniforms.uParallax.value = [p.x, p.y];
    }
    this.renderer.render(this.scene, this.camera);
  }

  _loop(now = performance.now()) {
    if (document.hidden || this.reduced) return;
    // ~30fps is plenty for drifting dust and saves the battery.
    if (now - this.last > 32) {
      this.last = now;
      this._draw((now - this.start) / 1000);
    }
    requestAnimationFrame(this._loop);
  }
}
