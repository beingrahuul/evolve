// World geometry and simulation constants.
// World units: x to the right, y downward. Water surface is y = 0, the sky is y < 0.

export const WORLD_W = 1920;
export const WORLD_H = 1080;
export const SKY_H = 300;

export const CELL = 15; // fluid / chemistry grid cell size in world units
export const NX = WORLD_W / CELL; // 128
export const NY = WORLD_H / CELL; // 72

export const TPS = 60; // simulation ticks per simulated second
export const DT = 1 / TPS;
export const FIELD_EVERY = 3; // fluid + chemistry update every N ticks

export const MAX_ORGS = 3500;
export const MAX_PARTICLES = 9000;

export const FLOOR_RES = 4;
export const NFLOOR = WORLD_W / FLOOR_RES + 1;

/** The laws of the world that the player (god) can change at runtime. */
export interface GodParams {
  sun: number; // sunlight intensity multiplier
  dayLength: number; // seconds per day/night cycle
  tempOffset: number; // °C added to air and deep-water temperatures
  mutation: number; // global mutation multiplier
  viscosity: number; // water drag multiplier
  gravity: number; // sinking multiplier
  wind: number; // surface wind strength
  vents: number; // hydrothermal activity multiplier
  erosion: number; // rock weathering multiplier
  decay: number; // decomposition speed multiplier
  autoSeed: boolean; // re-seed life if everything dies
}

export const defaultParams = (): GodParams => ({
  sun: 1,
  dayLength: 120,
  tempOffset: 0,
  mutation: 1,
  viscosity: 1,
  gravity: 1,
  wind: 1,
  vents: 1,
  erosion: 1,
  decay: 1,
  autoSeed: true,
});

/** Chemistry & physics of the water column. Amounts are stored per grid cell. */
export const CHEM = {
  O2_EQ: 12, // dissolved O2 per cell when in equilibrium with an atmosphere of 1.0
  CO2_EQ: 20,
  ATM_CELLS: 60000, // size of the atmosphere reservoir, in cell-equivalents
  GAS_EXCHANGE: 0.35, // per second, at the surface
  HEAT_EXCHANGE: 0.25,
  SOLAR_HEAT: 0.5,
  DEEP_TEMP: 4,
  DEEP_COOL: 0.04,
  LIGHT_DEPTH: 330, // e-folding depth of sunlight
  SHADE_K: 0.0035, // light absorbed per unit of chlorophyll-mass
  BUOYANCY: 0.3, // flow acceleration per °C of temperature anomaly
  DAMPING: 0.12,
  VORTICITY: 1.2,
  VISCOSITY: 0.05,
  EDDY_RATE: 0.5, // new eddies per second at wind 1
  EDDY_STRENGTH: 14,
  MAX_FLOW: 45,
  WIND_FORCE: 12,
  SULF_OX: 0.03,
  DIFF_T: 0.1,
  DIFF_GAS: 0.1,
  DIFF_NUT: 0.12,
  DIFF_SULF: 0.06,
  VENT_TEMP: 95,
  VENT_SULFIDE: 7,
  VENT_NUTRIENT: 0.06,
  VENT_CO2: 0.6,
  VENT_JET: 55,
  VENT_HEAT: 0.25,
  EROSION: 0.0012,
};

/** Biology constants. Energy and mass are both measured in carbon units. */
export const BIO = {
  RADIUS_K: 2.0, // radius = K * sqrt(mass)
  NUT_RATIO: 0.08, // nutrient per unit of body mass
  BASE_METAB: 0.004, // energy per mass per second
  ORGAN_COST: [0.004, 0.004, 0.005, 0.003, 0.002, 0.006, 0.0015, 0.001],
  BRAIN_COST: 0.0006, // per hidden node (connections count 0.2)
  THRUST_COST: 0.06,
  GLOW_COST: 0.004,
  MOUTH_OPEN_COST: 0.0015,
  PHOTO: 0.35,
  CHEMO: 0.2,
  UPTAKE: 0.12,
  GROWTH: 0.08,
  GROWTH_COST: 0.25,
  SPEED: 40,
  DRAG: 1,
  SINK: 12,
  ENGULF: 3.5,
  BITE_PREY: 0.35, // mass of one bite, per unit predator mass × mouth power
  MULTI_COST: 0.0004, // upkeep per extra cell (adhesion, signalling)
  BITE: 0.8,
  SENSE_BASE: 6,
  SENSE_RANGE: 110,
  SPECIES_THRESHOLD: 0.7,
  DECAY: 0.01, // detritus decomposition per second
  PARTICLE_SINK: 8,
  BURIAL: 0.0015,
};
