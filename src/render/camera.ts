import { SKY_H, WORLD_H, WORLD_W } from '../sim/params';

/**
 * 2D camera. `zoom` is CSS pixels per world unit. The world always fills the view: you cannot
 * zoom out past the point where it would leave empty margins, nor pan beyond its edges.
 */
export class Camera {
  x = WORLD_W / 2;
  y = WORLD_H / 2;
  zoom = 1;
  viewW = 1;
  viewH = 1;
  /** The furthest out the camera can zoom: the world just covers the view. */
  minZoom = 1;

  setViewport(w: number, h: number) {
    // a canvas not laid out yet (e.g. in a hidden tab) has no size: wait for a real one
    if (w < 2 || h < 2) return;
    const first = this.viewW <= 1;
    this.viewW = w;
    this.viewH = h;
    this.minZoom = Math.max(w / WORLD_W, h / (WORLD_H + SKY_H));
    if (first) this.fit();
    else this.clamp();
  }

  /** Show as much of the world as fits: zoomed out fully, from high in the sky down into the sea. */
  fit() {
    this.zoom = this.minZoom;
    this.x = WORLD_W / 2;
    this.y = -SKY_H * 0.6 + this.viewH / 2 / this.zoom;
    this.clamp();
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

  /** Keep the view inside the world. */
  clamp() {
    this.zoom = Math.max(this.minZoom, Math.min(16, this.zoom));
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    this.x = Math.max(hw, Math.min(WORLD_W - hw, this.x));
    this.y = Math.max(-SKY_H + hh, Math.min(WORLD_H - hh, this.y));
  }

  /** Visible world rectangle. */
  bounds(): [number, number, number, number] {
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
  }
}
