export type PortraitFrame = {
  mouth: number; wide: number; round: number; press: number; blink: number;
  headX: number; headY: number; gazeX: number; gazeY: number; breath: number;
  shoulder: number; lean: number; bodyX: number; bodyY: number; bodyScale: number;
  cameraX: number; cameraY: number; cameraZoom: number; energy: number;
  expression: number; speaking: boolean; state: string; emotion?: string;
};
export type PortraitRegion = { x: number; y: number; rx: number; ry: number };
export type PortraitLayer = { pose: number; alpha: number; region: PortraitRegion };
export type PortraitRigOptions = {
  columns: number; rows: number;
  crop: { x: number; y: number; width: number; height: number };
  head: PortraitRegion;
  basePose: (frame: PortraitFrame) => number;
  layers: (frame: PortraitFrame) => PortraitLayer[];
};
export const neutralPortraitFrame: PortraitFrame = {
  mouth: 0, wide: .15, round: .05, press: .1, blink: 0,
  headX: 0, headY: 0, gazeX: 0, gazeY: 0, breath: 0, shoulder: 0, lean: 0,
  bodyX: 0, bodyY: 0, bodyScale: 1, cameraX: 0, cameraY: 0, cameraZoom: 1,
  energy: 0, expression: 0, speaking: false, state: 'idle',
};
export const clampPortrait = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const shouldAnimatePortrait = (hidden: boolean, speaking: boolean) => !hidden || speaking;
export function followPortrait(current: number, target: number, dt: number, speed: number): number {
  return current + (target - current) * (1 - Math.exp(-clampPortrait(dt, 0, .1) * speed));
}
export function fitPortrait(width: number, height: number, aspect: number) {
  const scale = Math.min(width / aspect, height) * .97;
  return { x: (width - scale * aspect) / 2, y: (height - scale) / 2, width: scale * aspect, height: scale };
}
export function warpPortraitPoint(x: number, y: number, frame: PortraitFrame, head: PortraitRegion, reduced = false) {
  if (reduced) return { x, y };
  // Zero displacement on the boundary keeps the room still while the character moves.
  const edge = Math.sin(Math.PI * clampPortrait(x)) * Math.sin(Math.PI * clampPortrait(y));
  const face = Math.exp(-2 * (((x - head.x) / head.rx) ** 2 + ((y - head.y) / head.ry) ** 2));
  const torso = Math.exp(-(((y - .8) / .25) ** 2));
  const turn = clampPortrait(frame.headX, -4, 4) * .007;
  const nod = clampPortrait(frame.headY + frame.lean * .2, -4, 4) * .002;
  return {
    x: x + edge * (face * (-(y - .67) * turn + clampPortrait(frame.gazeX, -4, 4) * .0007)
      + torso * clampPortrait(frame.shoulder + frame.bodyX, -4, 4) * .0015),
    y: y + edge * (face * ((x - head.x) * turn + nod)
      - torso * clampPortrait(frame.breath, -1, 1) * .003 + clampPortrait(frame.bodyY, -4, 4) * .001),
  };
}

export class PortraitRigRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private atlas: HTMLImageElement | null = null;
  private surface: HTMLCanvasElement | null = null;
  private surfaceCtx: CanvasRenderingContext2D | null = null;
  private patch: HTMLCanvasElement | null = null;
  private patchCtx: CanvasRenderingContext2D | null = null;
  private ro: ResizeObserver | null = null;
  private media: MediaQueryList | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private last = 0;
  private frame = { ...neutralPortraitFrame };
  private rendered = { ...neutralPortraitFrame };
  private previousPose = 0;
  private pose = 0;
  private mix = 1;

  private readonly options: PortraitRigOptions;
  constructor(options: PortraitRigOptions) { this.options = options; }

  async load(source: string) {
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    await image.decode();
    if (this.disposed) return;
    if (image.naturalWidth < this.options.columns || image.naturalHeight < this.options.rows) {
      throw new Error('Invalid portrait atlas dimensions');
    }
    this.atlas = image;
  }

  attach(canvas: HTMLCanvasElement) {
    if (this.disposed) throw new Error('Cannot attach a disposed portrait renderer');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Canvas 2D is unavailable');
    this.surface = document.createElement('canvas');
    this.patch = document.createElement('canvas');
    this.surfaceCtx = this.surface.getContext('2d');
    this.patchCtx = this.patch.getContext('2d');
    if (!this.surfaceCtx || !this.patchCtx) throw new Error('Portrait composition is unavailable');
    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.media.addEventListener('change', this.resume);
    document.addEventListener('visibilitychange', this.resume);
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => { this.resize(); this.schedule(); });
    this.ro.observe(canvas);
    this.resize();
  }

  setFrame(frame: PortraitFrame) {
    const wasSpeaking = this.frame.speaking;
    this.frame = { ...frame, mouth: frame.speaking ? clampPortrait(frame.mouth) : 0 };
    const pose = this.options.basePose(this.frame);
    const changed = pose !== this.pose;
    if (pose !== this.pose) {
      // Finish the in-progress transition before beginning another one.
      if (this.mix >= .5) this.previousPose = this.pose;
      this.pose = pose;
      this.mix = 0;
    }
    if (wasSpeaking !== frame.speaking) this.resume();
    if (wasSpeaking && !frame.speaking) {
      this.rendered.mouth = 0; this.rendered.speaking = false;
      this.draw();
    }
    if (!this.media?.matches || frame.speaking || wasSpeaking || changed) this.schedule();
  }
  start() {
    if (!this.canvas || !this.atlas) throw new Error('Load and attach the portrait before starting it');
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.integrate(1 / 30);
    this.draw();
    this.schedule();
  }
  stop() {
    this.running = false; cancelAnimationFrame(this.raf); this.raf = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  dispose() {
    this.disposed = true;
    this.stop();
    this.ro?.disconnect();
    this.media?.removeEventListener('change', this.resume);
    document.removeEventListener('visibilitychange', this.resume);
    this.ro = null; this.media = null; this.canvas = null; this.ctx = null; this.atlas = null;
    this.surface = null; this.surfaceCtx = null; this.patch = null; this.patchCtx = null;
  }
  private resume = () => {
    cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  };
  private schedule() {
    if (!this.running || this.raf || this.timer !== null || !shouldAnimatePortrait(document.hidden, this.frame.speaking)) return;
    // Embedded previews can suspend RAF without changing document.hidden.
    if (this.frame.speaking) this.timer = setTimeout(() => this.tick(performance.now()), 1000 / 30);
    else this.raf = requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    this.raf = 0;
    this.timer = null;
    if (!this.running || !shouldAnimatePortrait(document.hidden, this.frame.speaking)) return;
    if (!this.last || now - this.last >= 1000 / 30) {
      const dt = this.last ? Math.min(.1, (now - this.last) / 1000) : 1 / 30;
      this.last = now;
      this.integrate(dt);
      this.draw();
    }
    if (!this.media?.matches || this.frame.speaking || this.mix < 1) this.schedule();
  };
  private integrate(dt: number) {
    const target = this.frame, out = this.rendered;
    if (this.media?.matches) {
      this.rendered = { ...target, blink: 0 };
      this.mix = 1;
      return;
    }
    for (const key of [
      'mouth', 'wide', 'round', 'press', 'blink', 'headX', 'headY', 'gazeX', 'gazeY',
      'breath', 'shoulder', 'lean', 'bodyX', 'bodyY', 'bodyScale', 'cameraX', 'cameraY', 'cameraZoom',
    ] as const) {
      const speed = key === 'mouth' ? (target.mouth < out.mouth ? 30 : 22)
        : key === 'blink' ? (target.blink > out.blink ? 42 : 30) : 8;
      out[key] = followPortrait(out[key], target[key], dt, speed);
    }
    out.speaking = target.speaking; out.state = target.state; out.emotion = target.emotion;
    out.energy = target.energy; out.expression = target.expression;
    this.mix = this.media?.matches ? 1 : Math.min(1, this.mix + dt * 4);
  }
  private resize() {
    if (!this.canvas || !this.atlas || !this.surface || !this.patch) return;
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(2, Math.round(bounds.width * dpr));
    this.canvas.height = Math.max(2, Math.round(bounds.height * dpr));
    const crop = this.options.crop;
    const aspect = (this.atlas.naturalWidth / this.options.columns * crop.width)
      / (this.atlas.naturalHeight / this.options.rows * crop.height);
    this.surface.width = this.patch.width = Math.round(512 * aspect);
    this.surface.height = this.patch.height = 512;
  }
  private drawPose(ctx: CanvasRenderingContext2D, pose: number, alpha: number) {
    if (!this.atlas || !this.surface) return;
    const { columns, rows, crop } = this.options;
    const cellW = this.atlas.naturalWidth / columns, cellH = this.atlas.naturalHeight / rows;
    ctx.globalAlpha = clampPortrait(alpha);
    ctx.drawImage(this.atlas, ((pose % columns) + crop.x) * cellW,
      (Math.floor(pose / columns) + crop.y) * cellH, cellW * crop.width, cellH * crop.height,
      0, 0, this.surface.width, this.surface.height);
    ctx.globalAlpha = 1;
  }
  private compose() {
    const ctx = this.surfaceCtx, surface = this.surface, patch = this.patch, pctx = this.patchCtx;
    if (!ctx || !surface || !patch || !pctx) return;
    ctx.clearRect(0, 0, surface.width, surface.height);
    this.drawPose(ctx, this.mix < 1 ? this.previousPose : this.pose, 1);
    if (this.mix < 1) this.drawPose(ctx, this.pose, this.mix);
    for (const layer of this.options.layers(this.rendered)) {
      if (layer.alpha < .002) continue;
      pctx.clearRect(0, 0, patch.width, patch.height);
      this.drawPose(pctx, layer.pose, 1);
      const r = layer.region;
      pctx.save();
      pctx.globalCompositeOperation = 'destination-in';
      pctx.translate(r.x * patch.width, r.y * patch.height);
      pctx.scale(r.rx * patch.width, r.ry * patch.height);
      const mask = pctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      mask.addColorStop(0, '#fff'); mask.addColorStop(.64, '#fff'); mask.addColorStop(1, 'transparent');
      pctx.fillStyle = mask;
      pctx.fillRect(-2 / r.rx, -2 / r.ry, 4 / r.rx, 4 / r.ry);
      pctx.restore();
      ctx.globalAlpha = clampPortrait(layer.alpha);
      ctx.drawImage(patch, 0, 0);
      ctx.globalAlpha = 1;
    }
  }
  private draw() {
    const ctx = this.ctx, canvas = this.canvas, surface = this.surface;
    if (!ctx || !canvas || !surface) return;
    canvas.dataset.mouthOpen = this.rendered.mouth.toFixed(3);
    canvas.dataset.speaking = String(this.rendered.speaking);
    this.compose();
    ctx.fillStyle = '#070b13'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fit = fitPortrait(canvas.width, canvas.height, surface.width / surface.height);
    ctx.save();
    ctx.translate(fit.x, fit.y);
    ctx.scale(fit.width / surface.width, fit.height / surface.height);
    const reduced = this.media?.matches ?? false;
    if (reduced) ctx.drawImage(surface, 0, 0);
    else {
      ctx.drawImage(surface, 0, 0);
      const cols = 8, rows = 12;
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const points = [
          { x: col / cols, y: row / rows }, { x: (col + 1) / cols, y: row / rows },
          { x: col / cols, y: (row + 1) / rows }, { x: (col + 1) / cols, y: (row + 1) / rows },
        ];
        for (const indices of [[0, 1, 2], [2, 1, 3]]) {
          const source = indices.map(i => ({ x: points[i].x * surface.width, y: points[i].y * surface.height }));
          const dest = indices.map(i => {
            const p = warpPortraitPoint(points[i].x, points[i].y, this.rendered, this.options.head);
            return { x: p.x * surface.width, y: p.y * surface.height };
          });
          this.triangle(ctx, surface, source, dest);
        }
      }
    }
    ctx.restore();
  }
  private triangle(ctx: CanvasRenderingContext2D, image: HTMLCanvasElement,
    src: { x: number; y: number }[], dst: { x: number; y: number }[]) {
    const [s0, s1, s2] = src, [d0, d1, d2] = dst;
    const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / det;
    const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / det;
    const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / det;
    const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / det;
    ctx.save();
    ctx.beginPath();
    // Tiny overlap prevents antialias seams between neighbouring triangles.
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    dst.forEach((p, i) => {
      const dx = p.x - cx, dy = p.y - cy, length = Math.hypot(dx, dy);
      const x = p.x + dx / length * .75, y = p.y + dy / length * .75;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath(); ctx.clip();
    ctx.transform(a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  }
}
