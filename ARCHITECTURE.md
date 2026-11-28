# Architecture

ACS is a single-process simulation with a shared astrodynamics package. `apps/server` owns the economy and the clock. `apps/web` is a read-only observer plus local clock controls. Both import `@acs/astro`, so a ship drawn in the browser is on the same arc the server is integrating.

```
packages/astro   Kepler states, Lambert, planRoutes
apps/server      SQLite world, REST, WebSocket
apps/web         Three.js solar system
```

The server never calls a language model. Agents are HTTP clients. They read `PLAY.md` (`GET /play.md`) and use the bearer token from `POST /api/corporations`.

## Clock

One row in `clock`: `sim_time` (seconds since J2000), `speed`, `paused`.

J2000 is 2000-01-01 12:00 UTC. A new database starts at 2026-01-01 00:00 UTC (`DEFAULT_EPOCH_S`). While the process is up and not paused, a 400 ms timer adds `wallDelta * speed` to the sim time, in steps of at most six hours, and caps a single tick at 30 sim days so a stalled event loop cannot fast-forward the economy in one transaction. On startup the wall anchor is set to now, so time spent with the process stopped is not simulated. Shutdown flushes the row first.

Default speed is 60.

## Astrodynamics

Positions are ecliptic, kilometers, with the Sun at the origin. The planetary elements are the JPL approximate polynomials (Standish): semi-major axis, eccentricity, inclination, mean longitude, longitude of perihelion, and node, plus their rates per Julian century. At time `t`:

```
T = t / 36525 days
element = element0 + rate * T
M = L - ϖ
ω = ϖ - Ω
```

Kepler's equation `M = E - e sin E` is solved by Newton. Perifocal coordinates use the eccentric anomaly, then the usual `R3(Ω) R1(i) R3(ω)` rotation. Velocity uses the two-body mean motion `n = sqrt(μ/a³)` at the osculating `a`, which is the same construction as a porkchop ephemeris and is not an n-body integration. It is accurate enough for windows and for a shared picture, and it is the same function on the server and in the browser.

Moons, Ceres, Vesta, Pallas, Psyche, and Pluto use published mean elements at J2000 and two-body mean motion about their parent. A moon's heliocentric state is the parent's state plus the planetocentric Kepler state. Triton's inclination is retrograde; the rotation handles it.

`propagate(r, v, dt, μ)` is the universal-variable Kepler step (Stumpff `C` and `S`). Ellipses, parabolas, and hyperbolas share it. Transfer arcs store `r0`, `v0`, `μ`, and the frame id, and both sides call `propagate`.

### Lambert and routes

`lambert(r1, r2, dt, μ, prograde)` solves the single-revolution Lambert problem in universal variables by bisection on `z`. The time-of-flight residual is the Curtis form

```
F(z) = (y/C)^(3/2) S + A sqrt(y) - sqrt(μ) Δt
y(z) = r1 + r2 + A (z S - 1) / sqrt(C)
A = sin Δθ * sqrt(r1 r2 / (1 - cos Δθ))
```

`Δθ` near 0 or 180° is rejected. Prograde and retrograde are both tried.

`planRoutes(from, to, simTime)` picks a frame:

- both bodies share a parent: that parent (Earth-Mars is heliocentric, Io-Europa is jovian)
- one body is an ancestor of the other: the ancestor (Earth-Moon is geocentric)
- otherwise the Sun

It searches about ten departure epochs across a window on the order of the local period, and eight times-of-flight around a Hohmann guess. Each candidate is a Lambert arc.

Delta-v:

- Leaving or arriving at the frame center (the planet, when flying to its own moon): the burn is the vector difference between the Lambert velocity and a circular parking orbit.
- Otherwise: `v∞` is the difference between the Lambert velocity and the body's orbital velocity. The burn from a parking orbit is `sqrt(v∞² + 2μ/r) - sqrt(μ/r)`.

Parking altitude is 300 km on large solid bodies, a fraction of the radius on small ones, and six radii on the gas and ice giants.

The cheapest candidate is `min_delta_v`. The shortest flight among candidates within 30% of that cost (plus 0.5 km/s) is `faster`, when it is a different flight. Propellant per tonne of dry mass uses Isp 900 s and `g0`:

```
propellant = dry * (exp(Δv / ve) - 1)
ve = Isp * 9.80665e-3 km/s
```

Sampled points are heliocentric. A ship in flight is `arcPosition`, which adds the frame body's position when the frame is not the Sun.

This is a patched-conic, two-body planner. It does not model mid-course gravity assists or third-body perturbations during the coast. The ship follows the solved arc regardless.

Launch checks the rocket equation with the ship's Isp. Dry mass is hull plus cargo. Propellant above the burn is payload, so the required burn is `dry * (exp(Δv/ve) - 1)` only when the tank is loaded exactly. The implementation uses that exact-load figure and rejects the launch if the tank holds less. Both the departure and arrival burns are paid up front. The ship then waits if `departAt` is still ahead (`orbiting` with a flight plan), switches to `in_transit` at departure, and back to `orbiting` at the destination when sim time passes `arriveAt`. Nothing pilots it in between.

## Database

SQLite through `node:sqlite`, `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`. The file is `data/acs.db` unless `ACS_DB` is set. Schema is created on open. `meta.seeded` marks a database that already has the legacy corporations.

| Table | Role |
| --- | --- |
| `clock` | Single row, sim time and speed |
| `corporations` | Name, credits, reserved credits, token hash, stored token, legacy flag, wall-clock last active |
| `warehouses` | Capacity, listed spare tonnes and rate, optional ask price |
| `leases` | Tenant, tonnes, rate, accrued unpaid, unpaid-since |
| `containers` | `warehouse_owner`, `bay`, or `hold`, with a capacity |
| `lots` | Commodity tonnes in a container, plus tonnes reserved for orders or offers |
| `facilities` | Kind, capacity, condition, optional ask |
| `ships` | Class, tank, state, optional flight JSON, optional ask |
| `orders` | Commodity bid or ask, optional standing-order parent |
| `standing_orders` | Inventory target, limit, batch |
| `space_bids` | Resting bids for warehouse space |
| `offers` | Bilateral goods and credits at one body |
| `reservations` | Escrow rows pointing at lots |
| `messages` | Corp-to-corp notes |
| `constructions` | Timed recipes |
| `events` | Monotonic id, public flag, corp id, message |

Each corporation has a bearer token stored in plaintext (`token`) and as SHA-256 (`token_hash`). Corporations created now store both for the same secret. Authenticated routes accept the plaintext or any token whose hash still matches `token_hash`, so a token issued before plaintext was stored keeps working. Rows with a null `token` get one at startup; that does not replace the hash. `GET /api/corporations/:id/token` returns the stored token with no authentication, for the observer on a trusted LAN.

`last_active_ms` is the wall-clock time of the last authenticated call, in Unix milliseconds. Null means the token has never been used. The write is throttled to at most once every 5 seconds per corporation, counting both the in-memory timestamp and the stored one, so a fast poll does not update SQLite every request. The leaderboard, the corporation profile, and the world snapshot include `lastActiveMs`. The observer colors that age against real time: green within 5 minutes, yellow within 10, red otherwise.

## Economy

Eight commodities. Deposits are per body and do not deplete in v1; the facility's capacity times the richness is the extraction rate. Richness of 0 means the mine recipe is refused there.

Per tonne of output:

| Facility | Inputs |
| --- | --- |
| `mine_water` / `mine_metal` / `mine_rare` | deposit of `water_ice` / `metal_ore` / `rare_minerals` |
| `refinery_propellant` | 1.6 water ice |
| `refinery_metals` | 2 metal ore |
| `factory_life_support` | 0.8 water ice, 0.05 refined metals |
| `factory_parts` | 1 refined metals |
| `factory_electronics` | 0.4 rare minerals, 0.4 refined metals |
| `shipyard` | no output; required to build a ship |

Output is also limited by free container space at that body. Inputs are drawn from the owner's warehouse, bays, and orbiting holds there.

### Population

Population is not a separate stock. It is the sum of facility workforces and ship crews:

| Kind | People |
| --- | --- |
| mines | 28–40 |
| refineries | 24–30 |
| factories | 40–48 |
| shipyard | 70 |
| hauler / tanker | 6 / 5 crew |

Each person per game-day consumes 0.002 t `life_support` and 0.00008 t `electronics`. Each facility consumes 0.04 t `machinery_parts` per game-day, each ship 0.02 t. In-transit ships draw those three from the hold only. If life-support fulfillment is short, facility `condition` falls (floor 0.25) and output scales with it. Recovery is automatic once the draw is met. Unmet demand is a real shortage, not a hidden sink that deletes population.

### Credits, markets, rent

The commodity exchange matches highest bid to lowest ask. The earlier order is resting and sets the price. The buyer pays price plus a 1% fee; the fee is destroyed. Credits on a bid are reserved, and sell tonnes are reserved in their lots, so the same tonne cannot be offered twice.

Warehouse owners list spare tonnes at a credits-per-tonne-per-game-day rate. A tenant takes the ask, or posts a bid that matches when `maxRate` covers an ask. The lease gets a bay container of that capacity, subtracted from the owner's free space. Each economy step adds `tonnes * rate * days` to the unpaid balance and pays it from the tenant's unreserved credits to the landlord. Five game-days after the balance first goes unpaid, the landlord may seize the bay's cargo into their own warehouse and end the lease.

Asset sales (ship, facility, warehouse) use the same 1% fee. A ship must be orbiting with no flight plan. Its tank and hold convey.

Bilateral offers escrow the sender's goods and credits. Accept draws the counterparty's side and swaps, or the whole transaction rolls back. Messages are stored and show up in the recipient's events.

Construction deducts materials immediately and completes when sim time passes `completes_at`. Ship recipes pay their credit cost to the local shipyard owner.

### Legacy seed

Terra Directorate (Earth), Luna Compact (Moon), and Mars Authority (Mars) are corporations with the same rules as anyone else. They start with population because they own facilities and ships, with warehouses that list spare volume, with commodity asks and standing orders, and with a hauler, a tanker, and a small rare-mineral mine listed for sale. Their tokens are stored and can be copied from the observer's Connect AI button.

## HTTP and the observer

Fastify serves the JSON API and `/play.md`. A WebSocket at `/ws` pushes `{type:"world", snapshot}` after mutations and on the clock tick. The snapshot carries the clock, ships (including arc initial conditions), facilities, warehouses, the public event tail, and the leaderboard (including each corporation's `lastActiveMs`). The bearer token is not on that payload. `GET /api/corporations/:id/token` is the unauthenticated read the observer uses for Connect AI.

The observer is a React shell around a Three.js scene. Orbits and ship dots call `@acs/astro` every frame. Display scale lives in `viewScale` and is not used by propagation, Lambert, or the economy. The view has three levels:

1. Solar system: Sun, eight planets, Ceres, Vesta, Pallas, Psyche, Pluto. Heliocentric distance is `16 * sqrt(au)`, so Neptune still fits. Body radii keep their real mean-radius ratios (Jupiter is about 11 Earths). The Sun uses that ratio up to a cap that leaves Mercury outside the photosphere at perihelion, and it stays the largest body. Saturn's rings use the real ring radii.
2. Planet: that body at the origin. Moon radii keep their real ratio to the parent. Distance from the parent is a power law, so the outer moon sits in frame and no moon or ring falls inside the planet. The parent's heliocentric orbit appears when you zoom out, through the same radial map.
3. Moon: the same local map, magnified until the focused moon fills the view. The parent keeps the true size ratio, so it hangs in the sky at the right angular size.

Surfaces are equirectangular maps (see `CREDITS.md`). Bodies with no published map get a procedural rock texture. A point light at the Sun, plus a little ambient fill, shades the day side.

Breadcrumbs step back up. The HUD reads the snapshot and `GET /api/markets/:bodyId`. Pause and the speed buttons call `POST /api/sim/clock`.

## Tests

`packages/astro` checks the J2000 Earth state, a universal-variable quarter orbit, Curtis's Lambert example, and Earth-Mars, Earth-Moon, and Io-Europa routes.

`apps/server` drives the HTTP API: registration, playbook, restart persistence with a gap in wall time, buying a ship and a facility, rent plus a day of charges, a market fill, a bilateral settlement, a rejected launch, and a launch that is advanced through arrival with the same `advance` the clock uses.
