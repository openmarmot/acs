import { getBody, isAncestor, parkingRadiusKm, stateInFrame, bodyState } from "./bodies.js";
import { REFERENCE_ISP_S } from "./constants.js";
import { circularVelocity, propagate, propellantForDeltaV } from "./kepler.js";
import { lambert } from "./lambert.js";
import { add, cross, dot, norm, normalize, scale, sub, type Vec3 } from "./math.js";

export interface RouteOption {
  kind: "min_delta_v" | "faster";
  /** Total departure + arrival delta-v, km/s. */
  deltaV: number;
  deltaVDepart: number;
  deltaVArrive: number;
  /** Tonnes of propellant per tonne of dry mass (cargo included, propellant excluded) at the reference Isp. */
  propellantPerTonneDry: number;
  propellantFractionOfWet: number;
  referenceIspS: number;
  departAt: number;
  arriveAt: number;
  tofSeconds: number;
  frameId: string;
  /** Departure state in the frame, the initial condition ships propagate. */
  r0: [number, number, number];
  v0: [number, number, number];
  mu: number;
  /** Heliocentric samples for drawing the arc. */
  points: Array<{ t: number; x: number; y: number; z: number }>;
}

export interface FlightArc {
  frameId: string;
  mu: number;
  departAt: number;
  arriveAt: number;
  r0: [number, number, number];
  v0: [number, number, number];
}

function tup(p: Vec3): [number, number, number] {
  return [p.x, p.y, p.z];
}

function fromTup(p: [number, number, number]): Vec3 {
  return { x: p[0], y: p[1], z: p[2] };
}

/** Frame a transfer is solved in. "sun" means heliocentric. */
export function transferFrame(fromId: string, toId: string): string {
  if (fromId === toId) {
    throw new Error(`A route needs two different bodies, got "${fromId}" twice.`);
  }
  const from = getBody(fromId);
  const to = getBody(toId);
  if (from.parentId && from.parentId === to.parentId) return from.parentId;
  if (isAncestor(fromId, toId)) return fromId;
  if (isAncestor(toId, fromId)) return toId;
  return "sun";
}

function injectionFromInfinity(vInf: number, bodyId: string): number {
  const body = getBody(bodyId);
  const r = parkingRadiusKm(bodyId);
  const vCirc = Math.sqrt(body.mu / r);
  const vPeri = Math.sqrt(vInf * vInf + (2 * body.mu) / r);
  return Math.max(0, vPeri - vCirc);
}

interface Solved {
  deltaV: number;
  deltaVDepart: number;
  deltaVArrive: number;
  departAt: number;
  arriveAt: number;
  frameId: string;
  mu: number;
  r0: Vec3;
  v0: Vec3;
}

/** Parking-orbit point nearly opposite `target`, tilted so Lambert's 0°/180° singularity is avoided. */
function parkingPoint(target: Vec3, radius: number, hHint: Vec3): Vec3 {
  const radial = normalize(scale(target, -1));
  const hint = norm(hHint) > 1e-8 ? normalize(hHint) : { x: 0, y: 0, z: 1 };
  let tangential = cross(hint, radial);
  if (norm(tangential) < 1e-8) tangential = cross({ x: 0, y: 1, z: 0 }, radial);
  tangential = normalize(tangential);
  const tilt = 0.22;
  return scale(normalize(add(scale(radial, Math.cos(tilt)), scale(tangential, Math.sin(tilt)))), radius);
}

function solveOne(fromId: string, toId: string, departAt: number, tof: number, prograde: boolean): Solved | null {
  const frameId = transferFrame(fromId, toId);
  const mu = getBody(frameId).mu;
  const arriveAt = departAt + tof;
  const fromState = stateInFrame(fromId, departAt, frameId);
  const toState = stateInFrame(toId, arriveAt, frameId);
  const fromRel = fromState.r;
  const toRel = toState.r;

  const fromIsCenter = fromId === frameId;
  const toIsCenter = toId === frameId;
  const hHint = fromIsCenter ? cross(toRel, toState.v) : cross(fromRel, fromState.v);
  const r1 = fromIsCenter ? parkingPoint(toRel, parkingRadiusKm(fromId), hHint) : fromRel;
  const r2 = toIsCenter ? parkingPoint(r1, parkingRadiusKm(toId), hHint) : toRel;
  if (norm(sub(r1, r2)) < Math.min(parkingRadiusKm(fromId), parkingRadiusKm(toId))) return null;

  const sol = lambert(r1, r2, tof, mu, prograde);
  if (!sol) return null;

  const h = cross(r1, r2);
  let dv1: number;
  if (fromIsCenter) {
    const vCirc = circularVelocity(r1, mu, h);
    dv1 = norm(sub(sol.v1, vCirc));
  } else {
    const vBody = stateInFrame(fromId, departAt, frameId).v;
    dv1 = injectionFromInfinity(norm(sub(sol.v1, vBody)), fromId);
  }

  let dv2: number;
  if (toIsCenter) {
    const vCirc = circularVelocity(r2, mu, h);
    dv2 = norm(sub(sol.v2, vCirc));
  } else {
    const vBody = stateInFrame(toId, arriveAt, frameId).v;
    dv2 = injectionFromInfinity(norm(sub(sol.v2, vBody)), toId);
  }

  const deltaV = dv1 + dv2;
  if (!Number.isFinite(deltaV) || deltaV <= 0 || deltaV > 80) return null;
  return { deltaV, deltaVDepart: dv1, deltaVArrive: dv2, departAt, arriveAt, frameId, mu, r0: r1, v0: sol.v1 };
}

function hohmannTof(fromId: string, toId: string, t: number): number {
  const frameId = transferFrame(fromId, toId);
  const mu = getBody(frameId).mu;
  const r1 = Math.max(norm(stateInFrame(fromId, t, frameId).r), parkingRadiusKm(fromId));
  const r2 = Math.max(norm(stateInFrame(toId, t, frameId).r), parkingRadiusKm(toId));
  const a = (r1 + r2) / 2;
  return Math.PI * Math.sqrt((a * a * a) / mu);
}

function characteristicWindow(fromId: string, toId: string, tofH: number): number {
  const frame = transferFrame(fromId, toId);
  const periods = [fromId, toId]
    .filter((id) => id !== frame)
    .map((id) => {
      const orbit = getBody(id).orbit;
      if (!orbit) return tofH;
      if (orbit.model === "fixed") {
        const n = Math.sqrt(orbit.mu / orbit.aKm ** 3);
        return (2 * Math.PI) / n;
      }
      const dL = orbit.rates[3] ?? 360;
      const degPerSec = dL / (36525 * 86400);
      return degPerSec > 0 ? 360 / degPerSec : tofH;
    });
  const synodic = Math.max(tofH, ...periods);
  return Math.min(Math.max(synodic * 0.85, tofH), 900 * 86400);
}

function sampleArc(solved: Solved, count = 28): RouteOption["points"] {
  const points: RouteOption["points"] = [];
  for (let i = 0; i <= count; i++) {
    const t = solved.departAt + ((solved.arriveAt - solved.departAt) * i) / count;
    const rel = propagate(solved.r0, solved.v0, t - solved.departAt, solved.mu).r;
    const helio =
      solved.frameId === "sun" ? rel : add(bodyState(solved.frameId, t).r, rel);
    points.push({ t, x: helio.x, y: helio.y, z: helio.z });
  }
  return points;
}

function toOption(kind: RouteOption["kind"], solved: Solved): RouteOption {
  const fuel = propellantForDeltaV(1, solved.deltaV, REFERENCE_ISP_S);
  return {
    kind,
    deltaV: solved.deltaV,
    deltaVDepart: solved.deltaVDepart,
    deltaVArrive: solved.deltaVArrive,
    propellantPerTonneDry: fuel.propellantTons,
    propellantFractionOfWet: fuel.propellantFractionOfWet,
    referenceIspS: REFERENCE_ISP_S,
    departAt: solved.departAt,
    arriveAt: solved.arriveAt,
    tofSeconds: solved.arriveAt - solved.departAt,
    frameId: solved.frameId,
    r0: tup(solved.r0),
    v0: tup(solved.v0),
    mu: solved.mu,
    points: sampleArc(solved),
  };
}

/**
 * Search a porkchop of departure epochs and times of flight.
 * Returns a minimum-delta-v option and, when a distinct one exists, a faster option
 * that stays near the minimum-energy cost. Propellant is for a 900 s reference engine.
 */
export function planRoutes(fromBodyId: string, toBodyId: string, simTime: number): RouteOption[] {
  getBody(fromBodyId);
  getBody(toBodyId);
  const tofH = hohmannTof(fromBodyId, toBodyId, simTime);
  const window = characteristicWindow(fromBodyId, toBodyId, tofH);
  const departures: number[] = [];
  const nDep = 10;
  for (let i = 0; i < nDep; i++) departures.push(simTime + (window * i) / (nDep - 1));
  const factors = [0.4, 0.55, 0.75, 0.9, 1, 1.15, 1.45, 1.9];
  const candidates: Solved[] = [];
  for (const departAt of departures) {
    for (const f of factors) {
      const tof = Math.max(1800, tofH * f);
      for (const prograde of [true, false]) {
        const solved = solveOne(fromBodyId, toBodyId, departAt, tof, prograde);
        if (solved) candidates.push(solved);
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `No single-revolution transfer from "${fromBodyId}" to "${toBodyId}" converged at sim time ${simTime.toFixed(0)}. Try again a little later in the sim, or pick a different destination.`,
    );
  }
  candidates.sort((a, b) => a.deltaV - b.deltaV || a.arriveAt - b.arriveAt);
  const best = candidates[0]!;
  const near = candidates.filter((c) => c.deltaV <= best.deltaV * 1.3 + 0.5);
  near.sort((a, b) => a.arriveAt - a.departAt - (b.arriveAt - b.departAt));
  const faster = near[0]!;
  const options = [toOption("min_delta_v", best)];
  const same =
    Math.abs(faster.departAt - best.departAt) < 1 && Math.abs(faster.arriveAt - best.arriveAt) < 1;
  if (!same) options.push(toOption("faster", faster));
  return options;
}

/** Heliocentric position of a ship coasting on a filed arc. */
export function arcPosition(arc: FlightArc, t: number): Vec3 {
  const rel = propagate(fromTup(arc.r0), fromTup(arc.v0), t - arc.departAt, arc.mu).r;
  if (arc.frameId === "sun") return rel;
  return add(bodyState(arc.frameId, t).r, rel);
}

export function arcVelocity(arc: FlightArc, t: number): Vec3 {
  const rel = propagate(fromTup(arc.r0), fromTup(arc.v0), t - arc.departAt, arc.mu).v;
  if (arc.frameId === "sun") return rel;
  return add(bodyState(arc.frameId, t).v, rel);
}

/** Sanity helper for tests: specific angular momentum sign. */
export function specificEnergy(r: Vec3, v: Vec3, mu: number): number {
  return (dot(v, v) / 2) - mu / norm(r);
}
