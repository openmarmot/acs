import { AU_KM, CENTURY_S, MU_SUN } from "./constants.js";
import { stateFromMeanAnomaly, type KeplerElements } from "./kepler.js";
import { add, norm, rad, sub, type Vec3, wrapPi } from "./math.js";

export type BodyKind = "star" | "planet" | "moon" | "dwarf" | "asteroid";

/** Fixed two-body elements at J2000, argument of periapsis (not longitude). */
interface FixedOrbit {
  model: "fixed";
  mu: number;
  aKm: number;
  e: number;
  iDeg: number;
  omDeg: number;
  wDeg: number;
  MDeg: number;
}

/**
 * JPL approximate planetary elements (Standish).
 * `w` here is longitude of perihelion ϖ, degrees. Rates are per Julian century.
 * Valid roughly 1800–2050; outside that they are still a smooth Keplerian extrapolation.
 */
interface JplOrbit {
  model: "jpl";
  mu: number;
  /** [a AU, e, i deg, L deg, varpi deg, node deg] */
  el: number[];
  rates: number[];
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  parentId: string | null;
  /** GM of this body, km^3/s^2. */
  mu: number;
  radiusKm: number;
  color: string;
  /** Drawn in the uncluttered solar-system view (not moons). */
  systemView: boolean;
  orbit: FixedOrbit | JplOrbit | null;
}

const JPL: Record<string, { el: number[]; rates: number[] }> = {
  mercury: {
    el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rates: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  venus: {
    el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rates: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  },
  earth: {
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
    rates: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  },
  mars: {
    el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rates: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  jupiter: {
    el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rates: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  saturn: {
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rates: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  uranus: {
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rates: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  neptune: {
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rates: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
};

function jpl(id: string): JplOrbit {
  const row = JPL[id];
  if (!row) throw new Error(`missing jpl elements for ${id}`);
  return { model: "jpl", mu: MU_SUN, el: row.el, rates: row.rates };
}

function fixed(
  mu: number,
  aKm: number,
  e: number,
  iDeg: number,
  omDeg: number,
  wDeg: number,
  MDeg: number,
): FixedOrbit {
  return { model: "fixed", mu, aKm, e, iDeg, omDeg, wDeg, MDeg };
}

const GM = {
  sun: MU_SUN,
  mercury: 22031.868551,
  venus: 324858.592,
  earth: 398600.435507,
  mars: 42828.375214,
  jupiter: 1.26686534e8,
  saturn: 3.7931187e7,
  uranus: 5.793939e6,
  neptune: 6.836529e6,
  moon: 4902.800066,
  phobos: 0.7088,
  deimos: 0.0985,
  io: 5959.916,
  europa: 3202.739,
  ganymede: 9887.834,
  callisto: 7179.289,
  titan: 8978.1382,
  enceladus: 7.2027,
  rhea: 153.9426,
  iapetus: 120.5038,
  titania: 226.9,
  oberon: 205.3,
  triton: 1427.598,
  ceres: 62.6284,
  vesta: 17.288,
  pallas: 14.3,
  psyche: 1.53,
  pluto: 869.61,
};

/**
 * Mean elements at epoch J2000.
 * Planets: JPL heliocentric polynomials.
 * Moons: published mean planetocentric elements (a, e, i, node, argument, mean anomaly).
 * Dwarf planets and asteroids: published mean heliocentric elements, two-body mean motion.
 */
export const BODIES: BodyDef[] = [
  { id: "sun", name: "Sun", kind: "star", parentId: null, mu: GM.sun, radiusKm: 695700, color: "#ffd27a", systemView: true, orbit: null },

  { id: "mercury", name: "Mercury", kind: "planet", parentId: "sun", mu: GM.mercury, radiusKm: 2439.7, color: "#c4b8a5", systemView: true, orbit: jpl("mercury") },
  { id: "venus", name: "Venus", kind: "planet", parentId: "sun", mu: GM.venus, radiusKm: 6051.8, color: "#e6c07b", systemView: true, orbit: jpl("venus") },
  { id: "earth", name: "Earth", kind: "planet", parentId: "sun", mu: GM.earth, radiusKm: 6371, color: "#6ea8fe", systemView: true, orbit: jpl("earth") },
  { id: "mars", name: "Mars", kind: "planet", parentId: "sun", mu: GM.mars, radiusKm: 3389.5, color: "#e07a5f", systemView: true, orbit: jpl("mars") },
  { id: "jupiter", name: "Jupiter", kind: "planet", parentId: "sun", mu: GM.jupiter, radiusKm: 69911, color: "#d4a574", systemView: true, orbit: jpl("jupiter") },
  { id: "saturn", name: "Saturn", kind: "planet", parentId: "sun", mu: GM.saturn, radiusKm: 58232, color: "#ead7a1", systemView: true, orbit: jpl("saturn") },
  { id: "uranus", name: "Uranus", kind: "planet", parentId: "sun", mu: GM.uranus, radiusKm: 25362, color: "#7fd1c7", systemView: true, orbit: jpl("uranus") },
  { id: "neptune", name: "Neptune", kind: "planet", parentId: "sun", mu: GM.neptune, radiusKm: 24622, color: "#5b7cfa", systemView: true, orbit: jpl("neptune") },

  { id: "moon", name: "Moon", kind: "moon", parentId: "earth", mu: GM.moon, radiusKm: 1737.4, color: "#d5d8e0", systemView: false, orbit: fixed(GM.earth, 384399, 0.0549, 5.145, 125.08, 318.15, 135.27) },
  { id: "phobos", name: "Phobos", kind: "moon", parentId: "mars", mu: GM.phobos, radiusKm: 11.27, color: "#b7a89a", systemView: false, orbit: fixed(GM.mars, 9376, 0.0151, 1.093, 82.0, 280.0, 40.0) },
  { id: "deimos", name: "Deimos", kind: "moon", parentId: "mars", mu: GM.deimos, radiusKm: 6.2, color: "#a89888", systemView: false, orbit: fixed(GM.mars, 23463.2, 0.00033, 0.93, 80.0, 240.0, 160.0) },

  { id: "io", name: "Io", kind: "moon", parentId: "jupiter", mu: GM.io, radiusKm: 1821.6, color: "#e6d35c", systemView: false, orbit: fixed(GM.jupiter, 421700, 0.0041, 0.05, 43.0, 84.0, 20.0) },
  { id: "europa", name: "Europa", kind: "moon", parentId: "jupiter", mu: GM.europa, radiusKm: 1560.8, color: "#d9c7a2", systemView: false, orbit: fixed(GM.jupiter, 671034, 0.009, 0.47, 219.0, 88.0, 140.0) },
  { id: "ganymede", name: "Ganymede", kind: "moon", parentId: "jupiter", mu: GM.ganymede, radiusKm: 2634.1, color: "#c8b49a", systemView: false, orbit: fixed(GM.jupiter, 1070412, 0.0013, 0.2, 63.0, 192.0, 260.0) },
  { id: "callisto", name: "Callisto", kind: "moon", parentId: "jupiter", mu: GM.callisto, radiusKm: 2410.3, color: "#9a8f86", systemView: false, orbit: fixed(GM.jupiter, 1882709, 0.0074, 0.192, 298.0, 52.0, 310.0) },

  { id: "titan", name: "Titan", kind: "moon", parentId: "saturn", mu: GM.titan, radiusKm: 2574.7, color: "#e0b15a", systemView: false, orbit: fixed(GM.saturn, 1221870, 0.0288, 0.3485, 28.0, 186.0, 200.0) },
  { id: "enceladus", name: "Enceladus", kind: "moon", parentId: "saturn", mu: GM.enceladus, radiusKm: 252.1, color: "#e7f2f6", systemView: false, orbit: fixed(GM.saturn, 238042, 0.0047, 0.009, 160.0, 20.0, 90.0) },
  { id: "rhea", name: "Rhea", kind: "moon", parentId: "saturn", mu: GM.rhea, radiusKm: 763.8, color: "#d9d3c5", systemView: false, orbit: fixed(GM.saturn, 527108, 0.001, 0.345, 350.0, 10.0, 40.0) },
  { id: "iapetus", name: "Iapetus", kind: "moon", parentId: "saturn", mu: GM.iapetus, radiusKm: 734.5, color: "#b7aa98", systemView: false, orbit: fixed(GM.saturn, 3560820, 0.0286, 15.47, 81.0, 271.0, 320.0) },

  { id: "titania", name: "Titania", kind: "moon", parentId: "uranus", mu: GM.titania, radiusKm: 788.9, color: "#cfd6dc", systemView: false, orbit: fixed(GM.uranus, 435910, 0.0011, 0.34, 167.0, 284.0, 15.0) },
  { id: "oberon", name: "Oberon", kind: "moon", parentId: "uranus", mu: GM.oberon, radiusKm: 761.4, color: "#b7c0c4", systemView: false, orbit: fixed(GM.uranus, 583520, 0.0014, 0.058, 167.0, 104.0, 210.0) },
  { id: "triton", name: "Triton", kind: "moon", parentId: "neptune", mu: GM.triton, radiusKm: 1353.4, color: "#d7cfc4", systemView: false, orbit: fixed(GM.neptune, 354759, 0.000016, 156.865, 177.6, 344.0, 352.0) },

  { id: "ceres", name: "Ceres", kind: "dwarf", parentId: "sun", mu: GM.ceres, radiusKm: 469.7, color: "#c8c2b4", systemView: true, orbit: fixed(MU_SUN, 2.7658 * AU_KM, 0.0785, 10.593, 80.305, 73.597, 77.372) },
  { id: "vesta", name: "Vesta", kind: "asteroid", parentId: "sun", mu: GM.vesta, radiusKm: 262.7, color: "#d7d2c8", systemView: true, orbit: fixed(MU_SUN, 2.3615 * AU_KM, 0.0887, 7.14, 103.851, 151.199, 20.864) },
  { id: "pallas", name: "Pallas", kind: "asteroid", parentId: "sun", mu: GM.pallas, radiusKm: 256, color: "#b9b3a6", systemView: true, orbit: fixed(MU_SUN, 2.7724 * AU_KM, 0.2302, 34.93, 173.09, 310.05, 78.2) },
  { id: "psyche", name: "Psyche", kind: "asteroid", parentId: "sun", mu: GM.psyche, radiusKm: 113, color: "#e4c98a", systemView: true, orbit: fixed(MU_SUN, 2.9214 * AU_KM, 0.14, 3.1, 150.3, 228.0, 280.0) },
  { id: "pluto", name: "Pluto", kind: "dwarf", parentId: "sun", mu: GM.pluto, radiusKm: 1188.3, color: "#d2bfae", systemView: true, orbit: fixed(MU_SUN, 39.482 * AU_KM, 0.2488, 17.16, 110.299, 113.834, 14.53) },
];

const BY_ID = new Map(BODIES.map((b) => [b.id, b]));

export function getBody(id: string): BodyDef {
  const b = BY_ID.get(id);
  if (!b) {
    const known = BODIES.map((x) => x.id).join(", ");
    throw new Error(`Unknown body "${id}". Known bodies: ${known}.`);
  }
  return b;
}

export function tryBody(id: string): BodyDef | undefined {
  return BY_ID.get(id);
}

export function childBodies(parentId: string): BodyDef[] {
  return BODIES.filter((b) => b.parentId === parentId);
}

export function isAncestor(ancestorId: string, bodyId: string): boolean {
  let p = getBody(bodyId).parentId;
  while (p) {
    if (p === ancestorId) return true;
    p = getBody(p).parentId;
  }
  return false;
}

function elementsAt(orbit: FixedOrbit | JplOrbit, t: number): KeplerElements & { n: number } {
  if (orbit.model === "fixed") {
    const a = orbit.aKm;
    const n = Math.sqrt(orbit.mu / (a * a * a));
    return {
      mu: orbit.mu,
      a,
      e: orbit.e,
      i: rad(orbit.iDeg),
      om: rad(orbit.omDeg),
      w: rad(orbit.wDeg),
      M0: rad(orbit.MDeg),
      epoch: 0,
      n,
    };
  }
  const T = t / CENTURY_S;
  const aAu = orbit.el[0]! + orbit.rates[0]! * T;
  const e = orbit.el[1]! + orbit.rates[1]! * T;
  const inc = rad(orbit.el[2]! + orbit.rates[2]! * T);
  const L = rad(orbit.el[3]! + orbit.rates[3]! * T);
  const varpi = rad(orbit.el[4]! + orbit.rates[4]! * T);
  const Om = rad(orbit.el[5]! + orbit.rates[5]! * T);
  const a = aAu * AU_KM;
  const n = Math.sqrt(orbit.mu / (a * a * a));
  return {
    mu: orbit.mu,
    a,
    e,
    i: inc,
    om: Om,
    w: wrapPi(varpi - Om),
    M0: wrapPi(L - varpi),
    epoch: t,
    n,
  };
}

/** Position and velocity relative to the parent (heliocentric for sun-orbiting bodies). */
export function relativeState(id: string, t: number): { r: Vec3; v: Vec3 } {
  const body = getBody(id);
  if (!body.orbit) return { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
  const el = elementsAt(body.orbit, t);
  if (body.orbit.model === "jpl") {
    return stateFromMeanAnomaly(el, el.M0, el.n);
  }
  return stateFromMeanAnomaly(el, wrapPi(el.M0 + el.n * (t - el.epoch)), el.n);
}

const stateCache = new Map<string, { r: Vec3; v: Vec3 }>();
let cacheT = Number.NaN;

function cacheKey(id: string): string {
  return id;
}

/** Heliocentric ecliptic J2000 state, km and km/s. Moons include the parent's motion. */
export function bodyState(id: string, t: number): { r: Vec3; v: Vec3 } {
  if (t !== cacheT) {
    stateCache.clear();
    cacheT = t;
  }
  const hit = stateCache.get(id);
  if (hit) return hit;
  const body = getBody(id);
  if (!body.parentId) {
    const zero = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
    stateCache.set(id, zero);
    return zero;
  }
  const rel = relativeState(id, t);
  const parent = bodyState(body.parentId, t);
  const state = { r: add(parent.r, rel.r), v: add(parent.v, rel.v) };
  stateCache.set(cacheKey(id), state);
  return state;
}

export function position(id: string, t: number): Vec3 {
  return bodyState(id, t).r;
}

export function velocity(id: string, t: number): Vec3 {
  return bodyState(id, t).v;
}

/** State relative to `frameId` (use "sun" for heliocentric). */
export function stateInFrame(id: string, t: number, frameId: string): { r: Vec3; v: Vec3 } {
  const abs = bodyState(id, t);
  if (frameId === "sun") return abs;
  const frame = bodyState(frameId, t);
  return { r: sub(abs.r, frame.r), v: sub(abs.v, frame.v) };
}

export function orbitalPeriodS(id: string): number {
  const body = getBody(id);
  if (!body.orbit) return Number.POSITIVE_INFINITY;
  const el = elementsAt(body.orbit, 0);
  return (2 * Math.PI) / el.n;
}

/** Parking-orbit radius used for departure and arrival burns. */
export function parkingRadiusKm(id: string): number {
  const body = getBody(id);
  if (body.kind === "star") return body.radiusKm + 2_000_000;
  if (body.kind === "planet" && body.radiusKm > 20000) return body.radiusKm * 6;
  const alt = body.radiusKm > 1000 ? 300 : Math.max(15, body.radiusKm * 0.2);
  return body.radiusKm + alt;
}

export function distanceKm(id: string, t: number): number {
  return norm(position(id, t));
}
