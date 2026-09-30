# Primordial

An artificial-life sandbox. It is a 2D cross-section of a primordial world: a sea with tides, a sky with weather, and a shore rising into land. Cells with genomes and neural-network brains live, compete, evolve into multicellular bodies and colonise the land, under simplified physics and chemistry. They court and mate, learn during their lives and signal to each other with pheromones. You are god: change the laws of nature, reshape the world, and click anything to inspect it.

```bash
npm install
npm run dev        # open http://localhost:5173
```

URL options: `?seed=123` for a specific world, `?size=standard` or `?size=vast` for another size (the default is wide), `?worker=0` to simulate on the main thread, `?pool=2&kernels=1` to choose how many helper threads the simulation uses.

## What's simulated

| Layer | Model |
|---|---|
| **Water** | Incompressible fluid (stable-fluids solver, 128×75 grid). Currents come from wind stress, thermal buoyancy, vent jets and turbulent eddies. |
| **Tides** | The sea rises and falls twice a day. Water drains from and floods back into the surface rows, conserving what is dissolved in it. The beach between high and low water is a nursery for life leaving the sea. |
| **Weather** | A coarse air flow (48×15) with temperature, vapour and cloud water. Warm air rises and cools with height; vapour condenses into cloud, releasing heat that drives thunderstorms. Clouds rain out and shade the ground and sea. Storm systems drift through, and lightning strikes where clouds are tall and updrafts strong. |
| **Land & soil** | One shore rises through a beach into hills and mountains. Each soil column holds water, nutrients, humus, temperature and snow. Rain soaks in, evaporates back to the air, or runs downhill, carrying nutrients to the sea. Rock weathers into nutrients, and humus decomposes. |
| **Heat** | Solar heating, air–sea exchange that follows day and night, cold seafloor, hydrothermal vents. Warm water rises. |
| **Chemistry** | Dissolved O₂, CO₂, nutrients (N/P/Fe) and H₂S are advected and diffused by the flow. Carbon is conserved through the cycle: atmosphere ↔ water ↔ cells ↔ detritus ↔ sediment. |
| **Light** | Sunlight fades with depth and is shaded by phototrophs above, so cells compete for light. |
| **Rocks** | Mineral composition and hardness. They weather into nutrients, faster in CO₂-rich (acidic) water. |
| **Cells** | The genome sets organelle investment (chloroplasts, chemosynthesis, mouth, flagella, armour, senses, gas vacuole, storage), plus size, thermal niche, lifespan and mutation rate. |
| **Bodies** | A body plan of up to 12 cells: a generalist core plus specialists (photocyte, chemocyte, mouth, motor, shell, eye, float, fat and root cells). A specialist cell is more efficient than a generalist. Bodies grow cell by cell from a bud; single cells split in two. |
| **Senses** | Eye cells extend sight only in the direction they face. Chemotaxis compares the light, nutrients and sulfide just ahead with just behind. Kin are sensed separately from strangers. |
| **Life on land** | Out of the water, cells breathe the air, take nutrients and water from the soil, and dry out unless protected by a waxy cuticle or rooted in moist soil. They crawl or root: rooted plants turn their growing tip towards the light and compete to be tallest, because the canopy shades everything below it. Seeds ride the wind, and bodies rot into humus. |
| **Sex** | A sex-drive gene sets how long an organism that is ready to breed courts a mate (shown by a rose-coloured pulse) before dividing alone. Two courting organisms close enough to exchange gametes, and genetically close enough to interbreed, both conceive. Their young get each gene from one parent or the other (NEAT-style crossover of the brain; the body plan is aligned cell by cell). Rooted plants cross-pollinate over a distance, further downwind. Whether sex pays is left to evolution: in some worlds it spreads, in others clones win. |
| **Learning** | Synapses can be plastic. A reward signal (food intake better or worse than the organism expected, minus pain) strengthens or weakens the plastic synapses that were recently active, through eligibility traces. Learned weights fade back to the genome's over a minute or two and are not inherited. Plasticity costs energy, and both the learning rate and which synapses learn are genes. |
| **Signals** | Two pheromones (A and B) are released by brain outputs, drift with the currents and break down. Cells sense how strong each is and whether it is stronger ahead or behind. They also see the glow of their nearest relative and whether it is courting. What the signals mean (alarm, a mating call, a trail) is left to evolution. |
| **Predation** | Prey that fits in a mouth is swallowed whole; anything bigger is bitten. Armour blunts both. Each meal takes time to digest, full predators stop hunting, and close kin are spared unless the predator is starving. |
| **Metabolism** | Respiration (fermentation when O₂ is low), photosynthesis, chemosynthesis, nutrient uptake, growth, division, starvation, heat and sulfide damage. |
| **Brains** | NEAT-style networks that grow neurons and synapses through mutation. There are 39 senses (light, gravity, chemistry and chemical gradients, food, strangers and kin, prey colour, pain, water, hydration, rain, pheromones, a courting relative, being ready to breed, an internal clock) and 7 actions (thrust, turn, eat, float, glow, release pheromone A or B). |
| **Evolution** | Mutation at every birth, recombination when two parents mate. Species are clustered by genetic distance, and each new species gets a generated Latin name. |
| **Bigger worlds** | Worlds come in three widths: Standard (one coast), Wide (a continent and an island; the default) and Vast (an archipelago), with the population cap scaled to match. |
| **Speed** | The simulation runs in a Web Worker, so drawing and the panels never slow it down, and it keeps running when the tab is in the background. It also spreads over several cores (see below). |

## Controls

- **Drag** to pan, **scroll** to zoom, **click** anything to inspect it (a cell, rock, vent, detritus, water, sky or seafloor). The world always fills the screen: you cannot zoom out or pan past its edges.
- **Space** pauses, **+/−** change speed, **.** steps one tick, **F** follows the selected cell, **H** zooms all the way out, **O** cycles overlays.
- **Notifications** (the bell in the header): every event of the world (new species, extinctions, matings, acts of god, lightning) is kept there, with filters, instead of popping up over the world.
- **Tools** (keys 1–0, X, R, L, G, B): inspect, create life, food, heat, cool, minerals, sulfide, current, rock, vent, smite, rain cloud, lightning, raise land, dig.
- **Laws of nature**: sunlight, day length, climate, mutation, viscosity, gravity, wind, vent activity, erosion, decay, tides, humidity, storms, learning, pheromones.
- **Acts of god**: meteor strike, eruption, nutrient bloom, ice age, heat wave, thunderstorm, drought, mass extinction, seed life.
- **Click anything**: an organism, rock, vent, detritus, the water, the seafloor, a cloud, a parcel of air, or the land.
- **Overlays** (O): temperature, O₂, CO₂, nutrients, sulfide, light, flow, humidity and signals (pheromone A violet, B aqua).
- **Charts**: species, lifestyles, atmosphere, and behaviour (the share of births that are sexual, mean sex drive, learners, signallers).
- **Tree of life** (T, or the button in the species list): every lineage as a timeline bar; click one to find it.
- **World** panel: new world (seed and size), re-seeding, the simulation thread's speed, and save & load (download a `.primordial` file, open one, or quick-save in the browser). Saves from older versions still open.

## Using several cores

The simulation thread shares its work with helper threads through shared memory:

- **Sensing and brains.** Each tick, every organism's senses (its neighbours, the smell of detritus, the chemistry around it) and its brain are computed in slices by a pool of threads. Brains live in a shared arena so any thread can run them.
- **The environment.** The sea, air and soil step runs on a thread of its own, one step behind life, and is merged back with whatever life changed meanwhile, so nothing is lost. That thread has its own small pool for the water's heavy loops (pressure, advection, diffusion, light).
- **The rest of life** (eating, metabolism, growth, breeding, movement, collisions) stays on the simulation thread. It is now the limit.

On an 8-core Apple M2, a Wide world with ~800 organisms runs at 16× real time on five threads, against 9× on one. Shared memory needs a *cross-origin-isolated* page. `npm run dev` and `npm run preview` send the right headers (`vite.config.ts`). A host that does not send them still works, with the simulation on one thread. The World panel shows how many threads are in use.

`scripts/bench.ts` compares one thread with several under Node (see its header for how to run it).

## Project layout

```
src/sim/      simulation (no DOM): world, fields (sea), atmosphere (weather), soil (land), life, genome, brain, species, serialize
src/sim/      worker.ts runs it in a Web Worker; sync.ts mirrors it to the main thread; commands.ts is every god action as data;
              threads.ts, pool.ts, helper.ts spread it over several cores; board.ts is sensing; environment.ts the non-living step
src/host.ts   where the simulation runs (a worker, or the main thread as a fallback)
src/render/   WebGL2 renderer: procedural ocean, cells, rocks, bloom
src/ui/       panels: tool sidebar, header, inspector (brain + body plan), notifications, tree of life, charts, save/load, input
scripts/      headless runners used for tuning: headless.ts [seconds] [seed] [width], weather.ts (land & weather),
              phase4.ts (sex, learning, signals), evo.ts (long-run drift), loadsave.ts (open a save file),
              bench.ts (one thread vs several)
```

Headless timings under `tsx` are about 4× slower than in the browser; bundle first for real numbers:
`npx esbuild scripts/phase4.ts --bundle --platform=node --format=esm --outfile=/tmp/p4.mjs && node /tmp/p4.mjs 900 42`.

## Roadmap

- ~~**Phase 1:** single cells, water, chemistry, brains, god tools, inspector.~~
- ~~**Phase 2:** multicellular bodies, eyes and chemotaxis, bite attacks, a phylogenetic tree view, save and load.~~
- ~~**Phase 3:** weather (clouds, rain, storms), land and tides, colonisation of land.~~
- ~~**Phase 4:** sexual reproduction, learning within a lifetime, signalling, a Web Worker simulation for bigger worlds.~~
- **Phase 5, speed:** ~~multi-core simulation (sensing, brains and the environment on helper threads)~~. Next: organisms in shared memory, so the rest of life can be split over cores too.
- **Phase 6, complex bodies:** lift the 12-cell limit; bodies grown by developmental genes into tissues (wood, leaves and seeds for plants; muscle, gut, nerves and limbs for animals).
- **Phase 7, ecosystems:** eggs and seeds, parental care, parasites and disease, pollinators and fruit, seasons, rivers and lakes.
- **Phase 8, the god game:** replaying the tree of life, following a lineage across generations, a creature editor, challenges.
