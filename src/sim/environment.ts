import type { Atmosphere } from './atmosphere';
import type { Fields } from './fields';
import { AIR_CELL, AIR_NX, CELL, GodParams, NX } from './params';
import type { Rng } from './rng';
import type { Soil } from './soil';
import type { Terrain } from './terrain';

/** The non-living world: sea, air, soil and the ground under them. */
export interface Environment {
  fields: Fields;
  atmosphere: Atmosphere;
  soil: Soil;
  terrain: Terrain;
}

/**
 * Sea, sky and soil, coupled: one step of FIELD_EVERY ticks. Runs on the simulation thread, or on
 * a helper thread of its own (threads.ts). Returns where lightning struck, if it did.
 */
export function stepEnvironment(
  e: Environment,
  dtf: number,
  P: GodParams,
  sunNow: number,
  tideLevel: number,
  rng: Rng,
): { x: number; y: number } | null {
  const { fields: F, atmosphere: air, soil, terrain } = e;
  F.setSeaLevel(tideLevel);
  air.rebuild(terrain, F.seaLevel);
  // the ground and sea surface warm the air above them
  for (let i = 0; i < AIR_NX; i++) {
    const x = (i + 0.5) * AIR_CELL;
    if (air.overSea[i]) {
      const wc = F.column(x);
      const j = F.surfRow[wc];
      air.surfaceT[i] = j >= 0 ? F.temp[j * NX + wc] : 15;
    } else {
      let t = 0;
      let c = 0;
      for (let k = -2; k <= 2; k++) {
        const sc = soil.column(x + k * 8);
        t += soil.temp[sc];
        c++;
      }
      air.surfaceT[i] = t / c;
    }
  }
  air.climateT = 14 + 2 * sunNow + P.tempOffset;
  const strike = air.step(dtf, P, rng);
  // the air drives the sea: wind stress, air temperature, rain, cloud shade
  for (let i = 0; i < NX; i++) {
    const x = (i + 0.5) * CELL;
    const ac = air.column(x);
    F.windX[i] = air.surfaceWind(x) / 8;
    // the sea trades heat with the air above it, anchored to the climate
    F.airT[i] = 0.5 * air.surfaceAirT(x) + 0.5 * (13 + 9 * sunNow + P.tempOffset);
    F.sunCol[i] = 1 - 0.7 * air.shade[ac];
    const r = air.rainStep[ac];
    if (r > 0 && air.overSea[ac]) F.addSurface(i, -0.4 * r, 0.004 * r);
  }
  F.step(dtf, P, terrain, sunNow, rng);
  soil.step(dtf, P, terrain, air, F, sunNow);
  return strike;
}
