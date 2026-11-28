export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const V0: Vec3 = { x: 0, y: 0, z: 0 };

export function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function norm(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n < 1e-12) return { x: 1, y: 0, z: 0 };
  return scale(a, 1 / n);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function wrapPi(rad: number): number {
  const tau = Math.PI * 2;
  let x = rad % tau;
  if (x < 0) x += tau;
  return x;
}

export function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function rad(d: number): number {
  return (d * Math.PI) / 180;
}
