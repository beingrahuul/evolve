/** Uniform-grid spatial index rebuilt every tick with a counting sort. */
export class SpatialGrid {
  readonly cols: number;
  readonly rows: number;
  readonly start: Int32Array;
  items: Int32Array;
  private cellOf: Int32Array;
  private fill: Int32Array;

  constructor(
    readonly w: number,
    readonly h: number,
    readonly size: number,
    cap: number,
    readonly top = 0,
  ) {
    this.cols = Math.ceil(w / size);
    this.rows = Math.ceil((h - top) / size);
    this.start = new Int32Array(this.cols * this.rows + 1);
    this.fill = new Int32Array(this.cols * this.rows);
    this.items = new Int32Array(cap);
    this.cellOf = new Int32Array(cap);
  }

  cellX(x: number): number {
    const c = (x / this.size) | 0;
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  cellY(y: number): number {
    const r = ((y - this.top) / this.size) | 0;
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  build(n: number, xs: Float32Array, ys: Float32Array) {
    if (n > this.items.length) {
      this.items = new Int32Array(n * 2);
      this.cellOf = new Int32Array(n * 2);
    }
    const { start, fill, cellOf, items, cols } = this;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.cellY(ys[i]) * cols + this.cellX(xs[i]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
    fill.set(start.subarray(0, fill.length));
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
  }
}
