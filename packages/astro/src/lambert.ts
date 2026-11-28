import { clamp, cross, dot, norm, type Vec3 } from "./math.js";
import { stumpffC, stumpffS } from "./kepler.js";

export interface LambertSolution {
  v1: Vec3;
  v2: Vec3;
  /** Transfer angle actually flown, radians. */
  theta: number;
}

/**
 * Single-revolution Lambert solver in universal variables (Curtis / Vallado),
 * rooted by bisection. Distances in km, mu in km^3/s^2, dt in seconds.
 * Returns null when the geometry is singular or no single-rev root exists.
 */
export function lambert(
  r1v: Vec3,
  r2v: Vec3,
  dt: number,
  mu: number,
  prograde = true,
): LambertSolution | null {
  if (!(dt > 0) || !(mu > 0)) return null;
  const r1 = norm(r1v);
  const r2 = norm(r2v);
  if (r1 < 1 || r2 < 1) return null;

  const cz = cross(r1v, r2v).z;
  const cosD = clamp(dot(r1v, r2v) / (r1 * r2), -1, 1);
  let theta = Math.acos(cosD);
  if ((prograde && cz < 0) || (!prograde && cz >= 0)) theta = 2 * Math.PI - theta;
  const denom = 1 - Math.cos(theta);
  if (denom < 1e-10) return null;
  const A = Math.sin(theta) * Math.sqrt((r1 * r2) / denom);
  if (Math.abs(A) < 1e-8) return null;

  const yOf = (z: number) => r1 + r2 + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const F = (z: number) => {
    const yz = yOf(z);
    if (!Number.isFinite(yz) || yz < 0) return -1e30;
    const C = stumpffC(z);
    if (C <= 0) return -1e30;
    return (yz / C) ** 1.5 * stumpffS(z) + A * Math.sqrt(yz) - Math.sqrt(mu) * dt;
  };

  let zLo = -4 * Math.PI * Math.PI;
  let guard = 0;
  while (yOf(zLo) < 0 && guard < 400) {
    zLo += 0.1;
    guard++;
  }
  let tries = 0;
  while (F(zLo) > 0 && A < 0 && tries < 40) {
    zLo *= 2;
    tries++;
  }
  if (F(zLo) > 0) return null;
  // Stay clear of z = (2π)^2, where C(z) underflows to 0 and the one-rev ellipse is singular.
  let zHi = (2 * Math.PI - 1e-3) ** 2;
  if (!(F(zHi) > 0)) return null;

  for (let k = 0; k < 60; k++) {
    const z = 0.5 * (zLo + zHi);
    if (F(z) > 0) zHi = z;
    else zLo = z;
  }
  const z = 0.5 * (zLo + zHi);
  const yz = yOf(z);
  if (!Number.isFinite(yz) || yz <= 0) return null;
  const f = 1 - yz / r1;
  const g = A * Math.sqrt(yz / mu);
  if (!Number.isFinite(g) || Math.abs(g) < 1e-12) return null;
  const gdot = 1 - yz / r2;
  const v1 = {
    x: (r2v.x - f * r1v.x) / g,
    y: (r2v.y - f * r1v.y) / g,
    z: (r2v.z - f * r1v.z) / g,
  };
  const v2 = {
    x: (gdot * r2v.x - r1v.x) / g,
    y: (gdot * r2v.y - r1v.y) / g,
    z: (gdot * r2v.z - r1v.z) / g,
  };
  if (![v1.x, v1.y, v1.z, v2.x, v2.y, v2.z].every(Number.isFinite)) return null;
  return { v1, v2, theta };
}
