import { SKY_H, WORLD_H, WORLD_W } from '../sim/params';

/** 2D camera. `zoom` is CSS pixels per world unit. */
export class Camera {
  x = WORLD_W / 2;
  y = WORLD_H / 2;
  zoom = 1;
  viewW = 1;
  viewH = 1;
  fitZoom = 1;

  /** Screen area not covered by UI panels: [left, top, right, bottom] insets in CSS px. */
  insets: [number, number, number, number] = [0, 0, 0, 0];

  setViewport(w: number, h: number) {
    const first = this.viewW === 1;
    this.viewW = w;
    this.viewH = h;
    this.fitZoom = Math.min(w / (WORLD_W * 1.02), h / ((WORLD_H + SKY_H * 0.45) * 1.02));
    if (first) this.fit();
    this.clamp();
  }

  /** Show the whole world inside the area left free by the UI panels. */
  fit() {
    const [l, t, r, b] = this.insets;
    const fw = Math.max(200, this.viewW - l - r);
    const fh = Math.max(200, this.viewH - t - b);
    const sky = SKY_H * 0.35;
    this.zoom = Math.max(this.fitZoom * 0.75, Math.min(fw / (WORLD_W * 1.02), fh / ((WORLD_H + sky) * 1.02)));
    // centre the world in the free area
    const cxWorld = WORLD_W / 2;
    const cyWorld = (WORLD_H - sky) / 2;
    this.x = cxWorld - (l + fw / 2 - this.viewW / 2) / this.zoom;
    this.y = cyWorld - (t + fh / 2 - this.viewH / 2) / this.zoom;
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [this.x + (sx - this.viewW / 2) / this.zoom, this.y + (sy - this.viewH / 2) / this.zoom];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.zoom + this.viewW / 2, (wy - this.y) * this.zoom + this.viewH / 2];
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.zoom *= factor;
    this.clamp();
    const [nx, ny] = this.screenToWorld(sx, sy);
    this.x += wx - nx;
    this.y += wy - ny;
    this.clamp();
  }

  pan(dx: number, dy: number) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  clamp() {
    this.zoom = Math.max(this.fitZoom * 0.75, Math.min(16, this.zoom));
    // allow some slack beyond the world edges so panels never trap a corner
    const sx = this.viewW / 3 / this.zoom;
    const sy = this.viewH / 3 / this.zoom;
    this.x = Math.max(-sx * 0.5, Math.min(WORLD_W + sx * 0.5, this.x));
    this.y = Math.max(-SKY_H * 0.8, Math.min(WORLD_H + sy * 0.5, this.y));
  }

  /** Visible world rectangle. */
  bounds(): [number, number, number, number] {
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
  }
}
