# Primordial

An artificial-life sandbox. It is a 2D cross-section of a primordial ocean where single cells with genomes and neural-network brains live, compete and evolve under simplified physics and chemistry. You are god: change the laws of nature, reshape the world, and click anything to inspect it.

```bash
npm install
npm run dev        # open http://localhost:5173  (add ?seed=123 for a specific world)
```

## What's simulated

| Layer | Model |
|---|---|
| **Water** | Incompressible fluid (stable-fluids solver, 128×72 grid). Currents come from wind stress, thermal buoyancy, vent jets and turbulent eddies. |
| **Heat** | Solar heating, air–sea exchange that follows day and night, cold seafloor, hydrothermal vents. Warm water rises. |
| **Chemistry** | Dissolved O₂, CO₂, nutrients (N/P/Fe) and H₂S are advected and diffused by the flow. Carbon is conserved through the cycle: atmosphere ↔ water ↔ cells ↔ detritus ↔ sediment. |
| **Light** | Sunlight fades with depth and is shaded by phototrophs above, so cells compete for light. |
| **Rocks** | Mineral composition and hardness. They weather into nutrients, faster in CO₂-rich (acidic) water. |
| **Cells** | The genome sets organelle investment (chloroplasts, chemosynthesis, mouth, flagella, armour, senses, gas vacuole, storage), plus size, thermal niche, lifespan and mutation rate. |
| **Bodies** | A body plan of up to 12 cells: a generalist core plus specialists (photocyte, chemocyte, mouth, motor, shell, eye, float and fat cells). A specialist cell is more efficient than a generalist. Bodies grow cell by cell from a bud; single cells split in two. |
| **Senses** | Eye cells extend sight only in the direction they face. Chemotaxis compares the light, nutrients and sulfide just ahead with just behind. Kin are sensed separately from strangers. |
| **Predation** | Prey that fits in a mouth is swallowed whole; anything bigger is bitten. Armour blunts both. Each meal takes time to digest, full predators stop hunting, and close kin are spared unless the predator is starving. |
| **Metabolism** | Respiration (fermentation when O₂ is low), photosynthesis, chemosynthesis, nutrient uptake, growth, division, starvation, heat and sulfide damage. |
| **Brains** | NEAT-style networks that grow neurons and synapses through mutation. There are 29 senses (light, gravity, chemistry and chemical gradients, food, strangers and kin, prey colour, pain, an internal clock) and 5 actions (thrust, turn, eat, float, glow). |
| **Evolution** | Mutation at every division. Species are clustered by genetic distance, and each new species gets a generated Latin name. |

## Controls

- **Drag** to pan, **scroll** to zoom, **click** anything to inspect it (a cell, rock, vent, detritus, water, sky or seafloor).
- **Space** pauses, **+/−** change speed, **.** steps one tick, **F** follows the selected cell, **H** shows the whole world, **O** cycles overlays.
- **Tools** (keys 1–0, X): inspect, create life, food, heat, cool, minerals, sulfide, current, rock, vent, smite.
- **Laws of nature**: sunlight, day length, climate, mutation, viscosity, gravity, wind, vent activity, erosion, decay.
- **Acts of god**: meteor strike, eruption, nutrient bloom, ice age, heat wave, mass extinction, seed life.
- **Tree of life** (T, or the button in the species list): every lineage as a timeline bar; click one to find it.
- **Save & load** (World panel): download a `.primordial` file, open one, or quick-save in the browser.

## Project layout

```
src/sim/      simulation (no DOM): world, fields (fluid + chemistry), life, genome, brain, species, serialize
src/render/   WebGL2 renderer: procedural ocean, cells, rocks, bloom
src/ui/       panels: god panel, inspector (brain + body plan), tree of life, charts, save/load, input
scripts/      headless runners used for tuning (npx tsx scripts/headless.ts 600 42)
```

## Roadmap

- ~~**Phase 1:** single cells, water, chemistry, brains, god tools, inspector.~~
- ~~**Phase 2:** multicellular bodies, eyes and chemotaxis, bite attacks, a phylogenetic tree view, save and load.~~
- **Phase 3:** weather (clouds, rain, storms), land and tides, colonisation of land.
- **Phase 4:** sexual reproduction, learning within a lifetime, signalling, a Web Worker/WASM simulation for bigger worlds.
