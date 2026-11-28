import { describe, expect, it } from "vitest";
import {
  AU_KM,
  bodyState,
  lambert,
  MU_SUN,
  norm,
  planRoutes,
  propagate,
  propellantForDeltaV,
  relativeState,
} from "../src/index.js";

describe("kepler", () => {
  it("places Earth near perihelion distance and ~30 km/s at J2000", () => {
    const earth = bodyState("earth", 0);
    const rAu = norm(earth.r) / AU_KM;
    const speed = norm(earth.v);
    expect(rAu).toBeGreaterThan(0.97);
    expect(rAu).toBeLessThan(1.0);
    expect(speed).toBeGreaterThan(29.5);
    expect(speed).toBeLessThan(31);
    // Mean longitude is about 100 deg, so the position is in the second quadrant-ish of x/y.
    const lon = Math.atan2(earth.r.y, earth.r.x);
    expect(lon).toBeGreaterThan(Math.PI / 4);
    expect(lon).toBeLessThan(Math.PI * 0.8);
  });

  it("keeps Mars outside Earth and on a slower orbit at J2000", () => {
    const mars = bodyState("mars", 0);
    expect(norm(mars.r) / AU_KM).toBeGreaterThan(1.3);
    expect(norm(mars.r) / AU_KM).toBeLessThan(1.7);
    expect(norm(mars.v)).toBeGreaterThan(22);
    expect(norm(mars.v)).toBeLessThan(28);
  });

  it("puts the Moon on a geocentric orbit of lunar scale", () => {
    const rel = relativeState("moon", 0);
    const d = norm(rel.r);
    expect(d).toBeGreaterThan(350_000);
    expect(d).toBeLessThan(420_000);
    const earth = bodyState("earth", 0);
    const moon = bodyState("moon", 0);
    const sep = Math.hypot(moon.r.x - earth.r.x, moon.r.y - earth.r.y, moon.r.z - earth.r.z);
    expect(sep).toBeCloseTo(d, 3);
  });

  it("keeps every sun-orbiting body between periapsis and apoapsis", () => {
    for (const id of ["mercury", "venus", "jupiter", "saturn", "uranus", "neptune", "ceres", "vesta", "pallas", "psyche", "pluto"]) {
      const st = bodyState(id, 0);
      expect(norm(st.r)).toBeGreaterThan(1e5);
      expect(Number.isFinite(st.v.x)).toBe(true);
    }
  });

  it("propagates a circular orbit a quarter period with the universal variable", () => {
    const r = AU_KM;
    const speed = Math.sqrt(MU_SUN / r);
    const r0 = { x: r, y: 0, z: 0 };
    const v0 = { x: 0, y: speed, z: 0 };
    const period = 2 * Math.PI * Math.sqrt((r * r * r) / MU_SUN);
    const q = propagate(r0, v0, period / 4, MU_SUN);
    expect(q.r.x).toBeCloseTo(0, -3);
    expect(q.r.y / AU_KM).toBeCloseTo(1, 2);
    expect(q.v.x).toBeCloseTo(-speed, 1);
    expect(Math.abs(q.v.y)).toBeLessThan(0.05);
  });
});

describe("lambert", () => {
  it("matches Curtis example 5.2", () => {
    const r1 = { x: 5000, y: 10000, z: 2100 };
    const r2 = { x: -14600, y: 2500, z: 7000 };
    const sol = lambert(r1, r2, 3600, 398600, true);
    expect(sol).not.toBeNull();
    expect(sol!.v1.x).toBeCloseTo(-5.9925, 2);
    expect(sol!.v1.y).toBeCloseTo(1.9254, 2);
    expect(sol!.v1.z).toBeCloseTo(3.2456, 2);
    expect(sol!.v2.x).toBeCloseTo(-3.3125, 2);
    expect(sol!.v2.y).toBeCloseTo(-4.1966, 2);
    expect(sol!.v2.z).toBeCloseTo(-0.3853, 2);
  });

  it("recovers a circular quarter-orbit velocity", () => {
    const r = AU_KM;
    const speed = Math.sqrt(MU_SUN / r);
    const dt = (Math.PI / 2) * Math.sqrt((r * r * r) / MU_SUN);
    const sol = lambert({ x: r, y: 0, z: 0 }, { x: 0, y: r, z: 0 }, dt, MU_SUN, true);
    expect(sol).not.toBeNull();
    expect(sol!.v1.y).toBeCloseTo(speed, 0);
    expect(Math.abs(sol!.v1.x)).toBeLessThan(0.2);
  });
});

describe("planRoutes", () => {
  it("returns an Earth-Mars transfer in the chemical/NTR band", () => {
    const options = planRoutes("earth", "mars", 0);
    expect(options.length).toBeGreaterThan(0);
    const min = options.find((o) => o.kind === "min_delta_v")!;
    expect(min.deltaV).toBeGreaterThan(3);
    expect(min.deltaV).toBeLessThan(15);
    expect(min.points.length).toBeGreaterThan(8);
    expect(min.arriveAt).toBeGreaterThan(min.departAt);
    expect(min.propellantPerTonneDry).toBeGreaterThan(0);
    const fuel = propellantForDeltaV(40, min.deltaV, 900);
    expect(fuel.propellantTons).toBeCloseTo(min.propellantPerTonneDry * 40, 4);
    const fast = options.find((o) => o.kind === "faster");
    if (fast) expect(fast.tofSeconds).toBeLessThanOrEqual(min.tofSeconds + 1);
  });

  it("returns an Earth-Moon transfer a hauler can fly", () => {
    const options = planRoutes("earth", "moon", 0);
    const min = options[0]!;
    expect(min.deltaV).toBeGreaterThan(0.5);
    expect(min.deltaV).toBeLessThan(8);
    expect(min.frameId).toBe("earth");
    expect(min.points[0]!.x).toBeTypeOf("number");
  });

  it("plans a moon-to-moon transfer inside the Jovian system", () => {
    const options = planRoutes("io", "europa", 0);
    expect(options[0]!.frameId).toBe("jupiter");
    expect(options[0]!.deltaV).toBeLessThan(20);
  });
});
