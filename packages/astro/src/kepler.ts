import { G0_KM_S2, REFERENCE_ISP_S } from "./constants.js";
import { add, cross, dot, norm, normalize, scale, type Vec3, wrapPi } from "./math.js";

export interface KeplerElements {
  /** Gravitational parameter of the central body, km^3/s^2. */
  mu: number;
  /** Semi-major axis, km. Positive for ellipses. */
  a: number;
  e: number;
  /** Inclination, rad. */
  i: number;
  /** Longitude of the ascending node, rad. */
  om: number;
  /** Argument of periapsis, rad. */
  w: number;
  /** Mean anomaly at `epoch`, rad. */
  M0: number;
  /** Epoch, seconds (same clock as the query time). */
  epoch: number;
}

/**
 * Solve Kepler's equation M = E - e sin E for the eccentric anomaly.
 * Stable for the eccentricities used in this catalogue (e < 0.85).
 */
export function eccentricAnomaly(M: number, e: number): number {
  const m = wrapPi(M);
  let E = e < 0.8 ? m : Math.PI;
  for (let k = 0; k < 30; k++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Elliptic position and velocity in the central body's equatorial/ecliptic frame. */
export function keplerState(el: KeplerElements, t: number): { r: Vec3; v: Vec3 } {
  const n = Math.sqrt(el.mu / (el.a * el.a * el.a));
  const M = el.M0 + n * (t - el.epoch);
  return stateFromMeanAnomaly(el, M, n);
}

export function stateFromMeanAnomaly(
  el: Pick<KeplerElements, "a" | "e" | "i" | "om" | "w" | "mu">,
  M: number,
  n: number,
): { r: Vec3; v: Vec3 } {
  const E = eccentricAnomaly(M, el.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const xp = el.a * (cosE - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * sinE;
  const edot = n / (1 - el.e * cosE);
  const vxp = -el.a * sinE * edot;
  const vyp = el.a * Math.sqrt(1 - el.e * el.e) * cosE * edot;
  return rotatePerifocal(xp, yp, vxp, vyp, el.om, el.i, el.w);
}

/** Perifocal (x toward periapsis, z along h) to ecliptic / parent equatorial. */
export function rotatePerifocal(
  xp: number,
  yp: number,
  vxp: number,
  vyp: number,
  om: number,
  inc: number,
  w: number,
): { r: Vec3; v: Vec3 } {
  const co = Math.cos(w);
  const so = Math.sin(w);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const cO = Math.cos(om);
  const sO = Math.sin(om);
  const r11 = cO * co - sO * so * ci;
  const r12 = -cO * so - sO * co * ci;
  const r21 = sO * co + cO * so * ci;
  const r22 = -sO * so + cO * co * ci;
  const r31 = so * si;
  const r32 = co * si;
  return {
    r: { x: r11 * xp + r12 * yp, y: r21 * xp + r22 * yp, z: r31 * xp + r32 * yp },
    v: { x: r11 * vxp + r12 * vyp, y: r21 * vxp + r22 * vyp, z: r31 * vxp + r32 * vyp },
  };
}

/** Stumpff C(z). Series near zero avoids cancellation. */
export function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + (z * z) / 720 - (z * z * z) / 40320;
}

/** Stumpff S(z). */
export function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880;
}

/**
 * Universal-variable Kepler propagation. Handles ellipses, parabolas, and hyperbolas,
 * which is what transfer arcs need. `dt` is seconds.
 */
export function propagate(r0: Vec3, v0: Vec3, dt: number, mu: number): { r: Vec3; v: Vec3 } {
  if (Math.abs(dt) < 1e-6) return { r: { ...r0 }, v: { ...v0 } };
  const r0m = norm(r0);
  const v0m = norm(v0);
  const vr0 = dot(r0, v0) / r0m;
  const alpha = 2 / r0m - (v0m * v0m) / mu;
  const sqrtMu = Math.sqrt(mu);

  let chi: number;
  if (alpha > 1e-8) {
    chi = sqrtMu * dt * alpha;
  } else if (alpha < -1e-8) {
    const a = 1 / alpha;
    const sign = dt >= 0 ? 1 : -1;
    const num = -2 * mu * alpha * dt;
    const den = dot(r0, v0) + sign * Math.sqrt(-mu * a) * (1 - r0m * alpha);
    chi = Math.abs(den) > 1e-8 && num / den > 0 ? sign * Math.sqrt(-a) * Math.log(num / den) : sqrtMu * dt / r0m;
  } else {
    chi = sqrtMu * dt / r0m;
  }
  if (!Number.isFinite(chi) || chi === 0) chi = sqrtMu * dt / r0m;

  for (let k = 0; k < 60; k++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F =
      (r0m * vr0) / sqrtMu * chi * chi * C +
      (1 - alpha * r0m) * chi * chi * chi * S +
      r0m * chi -
      sqrtMu * dt;
    const dF =
      (r0m * vr0) / sqrtMu * chi * (1 - alpha * chi * chi * S) +
      (1 - alpha * r0m) * chi * chi * C +
      r0m;
    if (Math.abs(dF) < 1e-14) break;
    const dChi = F / dF;
    chi -= dChi;
    if (Math.abs(dChi) < 1e-10) break;
  }

  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - (chi * chi) / r0m * C;
  const g = dt - (chi * chi * chi) / sqrtMu * S;
  const r = add(scale(r0, f), scale(v0, g));
  const rm = norm(r);
  const fdot = (sqrtMu / (rm * r0m)) * chi * (z * S - 1);
  const gdot = 1 - (chi * chi) / rm * C;
  const vel = add(scale(r0, fdot), scale(v0, gdot));
  return { r, v: vel };
}

export function propellantForDeltaV(
  dryMassTons: number,
  deltaVKmS: number,
  ispS = REFERENCE_ISP_S,
): { propellantTons: number; massRatio: number; propellantFractionOfWet: number; exhaustVelocityKmS: number } {
  const ve = ispS * G0_KM_S2;
  if (deltaVKmS <= 0) {
    return { propellantTons: 0, massRatio: 1, propellantFractionOfWet: 0, exhaustVelocityKmS: ve };
  }
  const massRatio = Math.exp(deltaVKmS / ve);
  const propellantTons = dryMassTons * (massRatio - 1);
  return {
    propellantTons,
    massRatio,
    propellantFractionOfWet: 1 - 1 / massRatio,
    exhaustVelocityKmS: ve,
  };
}

/** Circular-orbit velocity at position `r`, prograde about hint angular-momentum direction. */
export function circularVelocity(r: Vec3, mu: number, hHint: Vec3): Vec3 {
  const rn = norm(r);
  const rhat = scale(r, 1 / rn);
  let h = norm(hHint) < 1e-9 ? { x: 0, y: 0, z: 1 } : hHint;
  let tangential = cross(normalize(h), rhat);
  if (norm(tangential) < 1e-8) {
    tangential = cross({ x: 0, y: 0, z: 1 }, rhat);
    if (norm(tangential) < 1e-8) tangential = cross({ x: 0, y: 1, z: 0 }, rhat);
  }
  return scale(normalize(tangential), Math.sqrt(mu / rn));
}
