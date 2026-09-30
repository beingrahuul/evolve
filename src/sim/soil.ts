import type { Atmosphere } from './atmosphere';
import type { Fields } from './fields';
import { BIO, CHEM, GodParams, NSOIL, SOIL, SOIL_RES } from './params';
import type { Terrain } from './terrain';
import { f32, u8 } from './shared';

/**
 * Land surface, one column every SOIL_RES units: soil water, nutrients, humus (dead organic matter),
 * temperature and snow. Plants and other land life draw on it; rain fills it; runoff drains to the sea.
 */
export class Soil {
  moisture = f32(NSOIL).fill(0.45);
  nutrient = f32(NSOIL).fill(0.25);
  organic = f32(NSOIL).fill(0.3);
  temp = f32(NSOIL).fill(14);
  snow = f32(NSOIL);
  /** 1 where the column is above the sea. */
  land = u8(NSOIL);
  /** Leaf area of land phototrophs in each column (averaged over the last step). */
  canopy = f32(NSOIL);
  /** Highest leaf (smallest y) in each column during the last step. */
  canopyTop = f32(NSOIL).fill(1e9);
  // accumulated by organisms between steps
  cover = f32(NSOIL);
  coverTop = f32(NSOIL).fill(1e9);
  coverTicks = 0;
  /** Recent rainfall (for the renderer's wet-ground look and the inspector). */
  wetness = f32(NSOIL);

  column(x: number): number {
    const i = Math.round(x / SOIL_RES);
    return i < 0 ? 0 : i >= NSOIL ? NSOIL - 1 : i;
  }

  step(dt: number, P: GodParams, t: Terrain, atm: Atmosphere, F: Fields, sunNow: number) {
    const sl = F.seaLevel;
    const inv = 1 / Math.max(1, this.coverTicks);
    for (let i = 0; i < NSOIL; i++) {
      this.canopy[i] = this.cover[i] * inv;
      this.canopyTop[i] = this.coverTop[i];
      this.cover[i] = 0;
      this.coverTop[i] = 1e9;
    }
    this.coverTicks = 0;

    for (let i = 0; i < NSOIL; i++) {
      const x = i * SOIL_RES;
      const fy = t.floorY(x);
      const isLand = fy < sl - 1;
      this.land[i] = isLand ? 1 : 0;
      if (!isLand) {
        // under water: saturated
        this.moisture[i] = 1;
        this.snow[i] = 0;
        this.temp[i] = F.temp[F.cellIndex(x, fy - 4)];
        continue;
      }
      const ac = atm.column(x);
      const alt = sl - fy;
      const sun = sunNow * (1 - 0.7 * atm.shade[ac]);
      // ground temperature: warmed by the sun, cooler at altitude, chilled at night
      const target = 12 + P.tempOffset + SOIL.HEAT_DAY * sun - 0.02 * alt - (sunNow <= 0 ? 3 : 0);
      this.temp[i] += (target - this.temp[i]) * Math.min(1, 0.12 * dt);
      // rain, or snow when it is freezing
      // only part of the rain soaks in (less into wet ground); the rest runs straight off
      const precip = atm.rainStep[ac] * SOIL.RAIN_TO_SOIL;
      if (this.temp[i] < 0) this.snow[i] += precip;
      else this.moisture[i] += precip * Math.max(0.1, 1 - this.moisture[i]);
      this.wetness[i] += (Math.min(1, atm.rain[ac] * 4) - this.wetness[i]) * Math.min(1, dt * 0.5);
      if (this.snow[i] > 0 && this.temp[i] > 1) {
        const melt = Math.min(this.snow[i], 0.02 * this.temp[i] * dt);
        this.snow[i] -= melt;
        this.moisture[i] += melt;
      }
      // evaporation and transpiration return water to the air (faster in the thin, windy air up high)
      const e = SOIL.EVAPORATION * this.moisture[i] * (0.25 + sun) * (1 + this.canopy[i] * 0.04) * (1 + alt / 250) * dt;
      this.moisture[i] -= e;
      atm.addVapour(ac, e * 2.5);
      // water percolates away, fastest on steep slopes (hills dry out, valleys stay wet)
      const slope = Math.abs(t.floorY(x + SOIL_RES) - t.floorY(x - SOIL_RES)) / (2 * SOIL_RES);
      this.moisture[i] -= SOIL.DRAINAGE * this.moisture[i] * (0.3 + slope * 2.5) * dt;
      // bedrock weathers into nutrients (faster when wet)
      this.nutrient[i] += SOIL.WEATHERING * P.erosion * (0.2 + this.moisture[i]) * dt;
      // humus decomposes into nutrients and CO₂
      const tf = Math.min(2, Math.max(0.2, Math.exp(0.0693 * (this.temp[i] - 20))));
      const d = this.organic[i] * SOIL.DECOMPOSE * P.decay * (0.15 + this.moisture[i]) * tf * dt;
      this.organic[i] -= d;
      this.nutrient[i] += d * BIO.NUT_RATIO;
      F.atmCO2 += d / (CHEM.ATM_CELLS * CHEM.CO2_EQ);
      F.atmO2 = Math.max(0, F.atmO2 - d / (CHEM.ATM_CELLS * CHEM.O2_EQ));
    }

    // runoff: water above field capacity flows downhill, carrying dissolved nutrients; at the coast it reaches the sea
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < NSOIL; i++) {
        if (!this.land[i] || this.moisture[i] <= SOIL.CAPACITY) continue;
        const x = i * SOIL_RES;
        const hl = i > 0 ? t.floorY(x - SOIL_RES) : -1e9;
        const hr = i < NSOIL - 1 ? t.floorY(x + SOIL_RES) : -1e9;
        const j = hl > hr ? i - 1 : i + 1; // larger y = lower ground
        if (j < 0 || j >= NSOIL) continue;
        const excess = (this.moisture[i] - SOIL.CAPACITY) * 0.5;
        const carried = this.nutrient[i] * Math.min(0.3, excess * 0.4);
        this.moisture[i] -= excess;
        this.nutrient[i] -= carried;
        if (this.land[j]) {
          this.moisture[j] += excess;
          this.nutrient[j] += carried;
        } else {
          // a river mouth: nutrients wash into the coastal sea
          F.addSurface(F.column(j * SOIL_RES), -0.02 * excess, carried);
        }
      }
    }
    for (let i = 0; i < NSOIL; i++) {
      if (this.moisture[i] < 0) this.moisture[i] = 0;
      if (this.moisture[i] > 1.2) this.moisture[i] = 1.2;
      if (this.nutrient[i] < 0) this.nutrient[i] = 0;
    }
  }

  /** Sunlight reaching an organism on land whose highest leaf is at `topY`. */
  lightAt(i: number, topY: number, ownLeaf: number): number {
    // the tallest plants in a column get full light; everything under their canopy is shaded
    if (topY <= this.canopyTop[i] + 3) return 1;
    return Math.exp(-0.05 * Math.max(0, this.canopy[i] - ownLeaf));
  }
}
