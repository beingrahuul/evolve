import { A, CT } from '../sim/genome';
import { MAX_ORGS, MAX_PARTICLES, NFLOOR, NX, NY, SKY_H, WORLD_H, WORLD_W } from '../sim/params';
import type { Selection, World } from '../sim/world';
import { Camera } from './camera';
import { Target, Uniforms, compileProgram, dataTexture, deleteTarget, getUniforms, makeTarget } from './gl';
import * as S from './shaders';

export interface ViewState {
  time: number; // real seconds, drives animation
  overlay: number;
  selection: Selection | null;
  highlightSpecies: number;
  brush: { x: number; y: number; r: number; visible: boolean; color: [number, number, number] } | null;
}

const CELL_FLOATS = 20;
const ROCK_FLOATS = 8;
const SPRITE_FLOATS = 8;
const MAX_SPRITES = MAX_PARTICLES + MAX_ORGS + 64;
const MAX_CELL_INSTANCES = 14000;

interface Prog {
  p: WebGLProgram;
  u: Uniforms;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly hdr: boolean;
  private dpr = 1;
  private w = 1;
  private h = 1;

  private bg: Prog;
  private rock: Prog;
  private cell: Prog;
  private sprite: Prog;
  private extract: Prog;
  private blur: Prog;
  private composite: Prog;

  private triBuf: WebGLBuffer;
  private quadBuf: WebGLBuffer;
  private triVaoBg: WebGLVertexArrayObject;
  private triVaoPost: WebGLVertexArrayObject;

  private cellBuf: WebGLBuffer;
  private cellVao: WebGLVertexArrayObject;
  private cellData = new Float32Array(MAX_CELL_INSTANCES * CELL_FLOATS);
  private rockBuf: WebGLBuffer;
  private rockVao: WebGLVertexArrayObject;
  private rockData = new Float32Array(256 * ROCK_FLOATS);
  private spriteBuf: WebGLBuffer;
  private spriteVao: WebGLVertexArrayObject;
  private spriteData = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);

  private f0 = new Float32Array(NX * NY * 4);
  private f1 = new Float32Array(NX * NY * 4);
  private texF0: WebGLTexture;
  private texF1: WebGLTexture;
  private texFloor: WebGLTexture;
  private floorData = new Float32Array(NFLOOR);
  private floorWorld: World | null = null;
  private ventData = new Float32Array(32);

  private scene!: Target;
  private bloomA!: Target;
  private bloomB!: Target;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');

    const prog = (vs: string, fs: string, name: string): Prog => {
      const p = compileProgram(gl, vs, fs, name);
      return { p, u: getUniforms(gl, p) };
    };
    this.bg = prog(S.BG_VS, S.BG_FS, 'background');
    this.rock = prog(S.ROCK_VS, S.ROCK_FS, 'rock');
    this.cell = prog(S.CELL_VS, S.CELL_FS, 'cell');
    this.sprite = prog(S.SPRITE_VS, S.SPRITE_FS, 'sprite');
    this.extract = prog(S.POST_VS, S.EXTRACT_FS, 'extract');
    this.blur = prog(S.POST_VS, S.BLUR_FS, 'blur');
    this.composite = prog(S.POST_VS, S.COMPOSITE_FS, 'composite');

    this.triBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.triVaoBg = this.fullscreenVao(this.bg.p);
    this.triVaoPost = this.fullscreenVao(this.extract.p);

    this.cellBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.cellData.byteLength, gl.DYNAMIC_DRAW);
    this.cellVao = this.instancedVao(this.cell.p, this.cellBuf, CELL_FLOATS * 4, [
      ['a_pr', 4, 0],
      ['a_look', 4, 16],
      ['a_al1', 4, 32],
      ['a_al2', 4, 48],
      ['a_misc', 4, 64],
    ]);
    this.rockBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rockBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.rockData.byteLength, gl.DYNAMIC_DRAW);
    this.rockVao = this.instancedVao(this.rock.p, this.rockBuf, ROCK_FLOATS * 4, [
      ['a_rock', 4, 0],
      ['a_col', 4, 16],
    ]);
    this.spriteBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteData.byteLength, gl.DYNAMIC_DRAW);
    this.spriteVao = this.instancedVao(this.sprite.p, this.spriteBuf, SPRITE_FLOATS * 4, [
      ['a_s', 4, 0],
      ['a_c', 4, 16],
    ]);

    this.texF0 = dataTexture(gl, NX, NY, gl.RGBA16F, gl.RGBA, this.f0);
    this.texF1 = dataTexture(gl, NX, NY, gl.RGBA16F, gl.RGBA, this.f1);
    this.texFloor = dataTexture(gl, NFLOOR, 1, gl.R16F, gl.RED, this.floorData);
  }

  private fullscreenVao(p: WebGLProgram): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    const loc = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private instancedVao(
    p: WebGLProgram,
    buf: WebGLBuffer,
    stride: number,
    attrs: [string, number, number][],
  ): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const q = gl.getAttribLocation(p, 'a_quad');
    gl.enableVertexAttribArray(q);
    gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [name, size, off] of attrs) {
      const loc = gl.getAttribLocation(p, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  resize(cssW: number, cssH: number, dpr: number) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (w === this.w && h === this.h && this.scene) return;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl;
    if (this.scene) {
      deleteTarget(gl, this.scene);
      deleteTarget(gl, this.bloomA);
      deleteTarget(gl, this.bloomB);
    }
    this.scene = makeTarget(gl, w, h, this.hdr);
    const bw = Math.max(1, Math.round(w / 4));
    const bh = Math.max(1, Math.round(h / 4));
    this.bloomA = makeTarget(gl, bw, bh, this.hdr);
    this.bloomB = makeTarget(gl, bw, bh, this.hdr);
  }

  private uploadFields(world: World) {
    const F = world.fields;
    const f0 = this.f0;
    const f1 = this.f1;
    const n = NX * NY;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      f0[k] = F.temp[i];
      f0[k + 1] = F.o2[i];
      f0[k + 2] = F.co2[i];
      f0[k + 3] = F.nut[i];
      f1[k] = F.u[i];
      f1[k + 1] = F.v[i];
      f1[k + 2] = F.sulf[i];
      f1[k + 3] = F.light[i];
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texF0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, f0);
    gl.bindTexture(gl.TEXTURE_2D, this.texF1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, f1);
    if (this.floorWorld !== world) {
      this.floorWorld = world;
      for (let i = 0; i < NFLOOR; i++) this.floorData[i] = world.terrain.floor[i] / WORLD_H;
      gl.bindTexture(gl.TEXTURE_2D, this.texFloor);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NFLOOR, 1, gl.RED, gl.FLOAT, this.floorData);
    }
  }

  render(world: World, cam: Camera, view: ViewState) {
    const gl = this.gl;
    const zoomDev = cam.zoom * this.dpr;
    const day = smoothstep(-0.25, 0.3, world.sunElev);
    const ambient = 0.22 + 0.78 * day;
    this.uploadFields(world);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);

    // --- background --------------------------------------------------------
    const bg = this.bg;
    gl.useProgram(bg.p);
    gl.uniform2f(bg.u.u_res, this.w, this.h);
    gl.uniform3f(bg.u.u_cam, cam.x, cam.y, zoomDev);
    gl.uniform2f(bg.u.u_world, WORLD_W, WORLD_H);
    gl.uniform1f(bg.u.u_sky, SKY_H);
    gl.uniform1f(bg.u.u_time, view.time);
    gl.uniform1f(bg.u.u_sun, world.sunNow);
    gl.uniform1f(bg.u.u_elev, world.sunElev);
    gl.uniform1f(bg.u.u_phase, world.dayPhase);
    gl.uniform1f(bg.u.u_zoom, zoomDev);
    gl.uniform1f(bg.u.u_wind, world.params.wind);
    gl.uniform1i(bg.u.u_overlay, view.overlay);
    const vents = world.terrain.vents;
    const nv = Math.min(8, vents.length);
    for (let i = 0; i < nv; i++) {
      this.ventData[i * 4] = vents[i].x;
      this.ventData[i * 4 + 1] = vents[i].y;
      this.ventData[i * 4 + 2] = Math.min(2, vents[i].power * world.params.vents);
      this.ventData[i * 4 + 3] = 0;
    }
    gl.uniform4fv(bg.u.u_vents, this.ventData);
    gl.uniform1i(bg.u.u_nvents, nv);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texF0);
    gl.uniform1i(bg.u.u_f0, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texF1);
    gl.uniform1i(bg.u.u_f1, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texFloor);
    gl.uniform1i(bg.u.u_floor, 2);
    gl.bindVertexArray(this.triVaoBg);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const [bx0, by0, bx1, by1] = cam.bounds();
    const sel = view.selection;

    // --- rocks ---------------------------------------------------------------
    const rocks = world.terrain.rocks;
    let nr = 0;
    for (const r of rocks) {
      if (nr >= 256) break;
      const b = nr * ROCK_FLOATS;
      const d = this.rockData;
      d[b] = r.x;
      d[b + 1] = r.y;
      d[b + 2] = r.r;
      d[b + 3] = r.seed;
      d[b + 4] = r.type.color[0];
      d[b + 5] = r.type.color[1];
      d[b + 6] = r.type.color[2];
      d[b + 7] = sel && sel.kind === 'rock' && sel.id === r.id ? 1 : 0;
      nr++;
    }
    if (nr > 0) {
      const p = this.rock;
      gl.useProgram(p.p);
      gl.uniform2f(p.u.u_res, this.w, this.h);
      gl.uniform3f(p.u.u_cam, cam.x, cam.y, zoomDev);
      gl.uniform1f(p.u.u_ambient, ambient);
      gl.uniform1f(p.u.u_worldH, WORLD_H);
      gl.uniform1f(p.u.u_time, view.time);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.rockBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.rockData, 0, nr * ROCK_FLOATS);
      gl.bindVertexArray(this.rockVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nr);
    }

    // --- detritus -----------------------------------------------------------
    const P = world.particles;
    const sd = this.spriteData;
    let ns = 0;
    const margin = 10;
    for (let i = 0; i < P.n; i++) {
      const x = P.x[i];
      const y = P.y[i];
      if (x < bx0 - margin || x > bx1 + margin || y < by0 - margin || y > by1 + margin) continue;
      const b = ns * SPRITE_FLOATS;
      const c = P.c[i];
      const age = Math.min(1, P.age[i] / 240);
      sd[b] = x;
      sd[b + 1] = y;
      sd[b + 2] = 0.9 + Math.sqrt(c) * 0.75;
      sd[b + 3] = 0;
      sd[b + 4] = 0.85 - age * 0.3;
      sd[b + 5] = 0.8 - age * 0.35;
      sd[b + 6] = 0.62 - age * 0.35;
      sd[b + 7] = (0.45 + 0.35 * ambient) * (1 - age * 0.3);
      ns++;
    }
    if (ns > 0) this.drawSprites(cam, zoomDev, view.time, ns);

    // --- cells ----------------------------------------------------------------
    const cd = this.cellData;
    let nc = 0;
    const selId = sel && sel.kind === 'organism' ? sel.id : -1;
    const cap = this.cellData.length / CELL_FLOATS;
    // colony matrix: a soft glow binding the cells of each multicellular body
    let nm = 0;
    for (const o of world.orgs) {
      if (o.dead || o.nCells < 2) continue;
      const m = o.radius * 1.5;
      if (o.x < bx0 - m || o.x > bx1 + m || o.y < by0 - m || o.y > by1 + m) continue;
      if (nm >= MAX_ORGS) break;
      const b = nm * SPRITE_FLOATS;
      const col = hsv(o.genome.hue, 0.45, 0.9);
      sd[b] = o.x;
      sd[b + 1] = o.y;
      sd[b + 2] = o.radius * 1.12;
      sd[b + 3] = 3;
      sd[b + 4] = col[0];
      sd[b + 5] = col[1];
      sd[b + 6] = col[2];
      sd[b + 7] = 0.2 + 0.12 * ambient;
      nm++;
    }
    if (nm > 0) this.drawSprites(cam, zoomDev, view.time, nm);

    for (const o of world.orgs) {
      if (o.dead) continue;
      const m = o.radius * 4;
      if (o.x < bx0 - m || o.x > bx1 + m || o.y < by0 - m || o.y > by1 + m) continue;
      if (nc + o.nCells > cap) break;
      const multi = o.nCells > 1;
      const cosH = Math.cos(o.heading) * o.scale;
      const sinH = Math.sin(o.heading) * o.scale;
      const energy = o.energy / o.ecap;
      const flags = (o.id === selId && !multi ? 1 : 0) + (o.species === view.highlightSpecies ? 4 : 0);
      for (let i = 0; i < o.nCells; i++) {
        const b = nc * CELL_FLOATS;
        const t = o.ctype[i];
        if (multi) {
          cd[b] = o.x + o.cx[i] * cosH - o.cy[i] * sinH;
          cd[b + 1] = o.y + o.cx[i] * sinH + o.cy[i] * cosH;
          cd[b + 2] = o.cellR(i);
          // specialists face outward (mouths and eyes point away from the body); motors trail behind
          cd[b + 3] = t === CT.Core || t === CT.Motor ? o.heading : o.heading + Math.atan2(o.cy[i], o.cx[i]);
        } else {
          cd[b] = o.x;
          cd[b + 1] = o.y;
          cd[b + 2] = o.radius;
          cd[b + 3] = o.heading;
        }
        cd[b + 4] = o.genome.hue;
        cd[b + 5] = energy;
        cd[b + 6] = o.thrust;
        cd[b + 7] = o.glow;
        if (t === CT.Core) {
          const f = o.coreFrac;
          cd[b + 8] = f[A.chloro] * 1.6;
          cd[b + 9] = f[A.chemo] * 1.6;
          cd[b + 10] = f[A.mouth] * 1.6;
          cd[b + 11] = Math.min(1, f[A.flagella] * 2);
          cd[b + 12] = Math.min(1, f[A.armor] * 2);
          cd[b + 13] = Math.min(1, f[A.sensor] * 2);
          cd[b + 14] = Math.min(1, f[A.vacuole] * 2);
          cd[b + 15] = Math.min(1, f[A.storage] * 2);
        } else {
          for (let q = 8; q < 16; q++) cd[b + q] = 0;
          cd[b + 8 + (t - 1)] = t === CT.Motor ? 0.75 : 0.95;
        }
        cd[b + 16] = (o.seed + i * 0.1373) % 1;
        const isMouth = t === CT.Mouth || (t === CT.Core && o.coreFrac[A.mouth] > 0.03);
        cd[b + 17] = flags + (o.eating && isMouth ? 2 : 0);
        cd[b + 18] = o.health;
        cd[b + 19] = o.inflate;
        nc++;
      }
    }
    if (nc > 0) {
      const p = this.cell;
      gl.useProgram(p.p);
      gl.uniform2f(p.u.u_res, this.w, this.h);
      gl.uniform3f(p.u.u_cam, cam.x, cam.y, zoomDev);
      gl.uniform1f(p.u.u_time, view.time);
      gl.uniform1f(p.u.u_ambient, ambient);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cd, 0, nc * CELL_FLOATS);
      gl.bindVertexArray(this.cellVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nc);
    }

    // --- markers: selection rings, brush cursor ------------------------------
    ns = 0;
    const ring = (x: number, y: number, r: number, kind: number, c: [number, number, number], a = 1) => {
      const b = ns * SPRITE_FLOATS;
      sd[b] = x;
      sd[b + 1] = y;
      sd[b + 2] = r;
      sd[b + 3] = kind;
      sd[b + 4] = c[0];
      sd[b + 5] = c[1];
      sd[b + 6] = c[2];
      sd[b + 7] = a;
      ns++;
    };
    const cyan: [number, number, number] = [0.5, 1.0, 1.0];
    if (sel) {
      if (sel.kind === 'organism') {
        const o = world.orgById.get(sel.id);
        if (o && o.nCells > 1) ring(o.x, o.y, o.radius * 1.3, 1, cyan);
      } else if (sel.kind === 'vent') {
        const v = vents.find((q) => q.id === sel.id);
        if (v) ring(v.x, v.y - 18, 34, 1, cyan);
      } else if (sel.kind === 'particle') {
        const i = P.indexOfUid(sel.uid);
        if (i >= 0) ring(P.x[i], P.y[i], 5, 1, cyan);
      } else if (sel.kind === 'water' || sel.kind === 'floor' || sel.kind === 'sky') {
        ring(sel.x, sel.y, 10, 1, cyan);
      }
    }
    if (view.brush && view.brush.visible) {
      ring(view.brush.x, view.brush.y, view.brush.r, 2, view.brush.color, 0.9);
    }
    if (ns > 0) this.drawSprites(cam, zoomDev, view.time, ns);

    // --- bloom + composite -----------------------------------------------------
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.triVaoPost);
    const bw = this.bloomA.w;
    const bh = this.bloomA.h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.extract.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.extract.u.u_tex, 0);
    gl.uniform2f(this.extract.u.u_texel, 1 / this.w, 1 / this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.blur.p);
    gl.uniform1i(this.blur.u.u_tex, 0);
    for (let pass = 0; pass < 2; pass++) {
      const spread = pass === 0 ? 1 : 2;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fb);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
      gl.uniform2f(this.blur.u.u_dir, spread / bw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
      gl.uniform2f(this.blur.u.u_dir, 0, spread / bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.composite.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.composite.u.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
    gl.uniform1i(this.composite.u.u_bloom, 1);
    gl.uniform1f(this.composite.u.u_bloomK, 0.85);
    gl.uniform1f(this.composite.u.u_time, view.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private drawSprites(cam: Camera, zoomDev: number, time: number, n: number) {
    const gl = this.gl;
    const p = this.sprite;
    gl.useProgram(p.p);
    gl.uniform2f(p.u.u_res, this.w, this.h);
    gl.uniform3f(p.u.u_cam, cam.x, cam.y, zoomDev);
    gl.uniform1f(p.u.u_time, time);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.spriteData, 0, n * SPRITE_FLOATS);
    gl.bindVertexArray(this.spriteVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
