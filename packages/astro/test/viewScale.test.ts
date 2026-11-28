import { describe, expect, it } from "vitest";
import {
  AU_KM,
  BODIES,
  cross,
  dot,
  getBody,
  norm,
  orbitalPeriodS,
  parentRelativeDisplayDistance,
  position,
  sub,
  viewBodyRadius,
  viewOffset,
  viewRingRadii,
  type ViewFocus,
} from "../src/index.js";

const system: ViewFocus = { level: "system" };

describe("view scale", () => {
  it("compresses heliocentric distance with a square root and keeps it monotonic", () => {
    const at = (au: number) => norm(viewOffset({ x: au * AU_KM, y: 0, z: 0 }, 0, system));
    expect(at(1)).toBeCloseTo(16, 8);
    expect(at(4)).toBeCloseTo(32, 8);
    expect(at(0.25)).toBeCloseTo(8, 8);
    let prev = 0;
    for (const au of [0.3, 1, 5.2, 9.5, 30, 39]) {
      const d = at(au);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it("keeps real radius ratios in the system view and draws the Sun largest", () => {
    const earth = viewBodyRadius("earth", system);
    const jupiter = viewBodyRadius("jupiter", system);
    expect(jupiter / earth).toBeCloseTo(getBody("jupiter").radiusKm / getBody("earth").radiusKm, 8);
    expect(viewBodyRadius("saturn", system) / earth).toBeCloseTo(getBody("saturn").radiusKm / getBody("earth").radiusKm, 8);
    expect(viewBodyRadius("ganymede", system) / viewBodyRadius("io", system)).toBeCloseTo(
      getBody("ganymede").radiusKm / getBody("io").radiusKm,
      8,
    );
    const sun = viewBodyRadius("sun", system);
    for (const body of BODIES) {
      if (body.id === "sun") continue;
      expect(sun).toBeGreaterThan(viewBodyRadius(body.id, system));
    }
    expect(sun / jupiter).toBeGreaterThan(1.7);
  });

  it("keeps Mercury outside the Sun even at perihelion", () => {
    const sun = viewBodyRadius("sun", system);
    const mercuryR = viewBodyRadius("mercury", system);
    const period = orbitalPeriodS("mercury");
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 24; i++) {
      const t = (period * i) / 24;
      const dist = norm(viewOffset(position("mercury", t), t, system));
      closest = Math.min(closest, dist);
      expect(dist).toBeGreaterThan(sun + mercuryR);
    }
    expect(closest - sun - mercuryR).toBeGreaterThan(sun * 0.3);
  });

  it("keeps Saturn's rings from meeting Jupiter when the orbits are closest", () => {
    const j = getBody("jupiter").orbit;
    const s = getBody("saturn").orbit;
    expect(j?.model).toBe("jpl");
    expect(s?.model).toBe("jpl");
    if (!j || j.model !== "jpl" || !s || s.model !== "jpl") return;
    const jAp = (j.el[0] ?? 0) * (1 + (j.el[1] ?? 0));
    const sPe = (s.el[0] ?? 0) * (1 - (s.el[1] ?? 0));
    const gap = 16 * Math.sqrt(sPe) - 16 * Math.sqrt(jAp);
    const rings = viewRingRadii(system);
    expect(rings).not.toBeNull();
    expect(gap).toBeGreaterThan(viewBodyRadius("jupiter", system) + (rings?.outer ?? 0));
    expect(rings!.inner / viewBodyRadius("saturn", system)).toBeCloseTo(66_900 / getBody("saturn").radiusKm, 5);
    expect(rings!.outer / viewBodyRadius("saturn", system)).toBeCloseTo(136_780 / getBody("saturn").radiusKm, 5);
  });

  it("keeps every moon outside its parent, at the true radius ratio, in both local views", () => {
    const moons = BODIES.filter((body) => body.kind === "moon");
    expect(moons.length).toBeGreaterThan(10);
    for (const moon of moons) {
      const parentId = moon.parentId;
      expect(parentId).toBeTruthy();
      if (!parentId) continue;
      const orbit = moon.orbit;
      expect(orbit?.model).toBe("fixed");
      if (!orbit || orbit.model !== "fixed") continue;
      const minKm = orbit.aKm * (1 - orbit.e);
      const parentKm = getBody(parentId).radiusKm;
      expect(minKm).toBeGreaterThan(parentKm + moon.radiusKm);
      const focuses = [
        { level: "planet", id: parentId },
        { level: "moon", id: moon.id },
      ] as const;
      for (const focus of focuses) {
        const dist = parentRelativeDisplayDistance(minKm, focus);
        const parentR = viewBodyRadius(parentId, focus);
        const moonR = viewBodyRadius(moon.id, focus);
        expect(dist, `${moon.id} ${focus.level}`).toBeGreaterThan(parentR + moonR);
        expect(moonR / parentR).toBeCloseTo(moon.radiusKm / parentKm, 6);
        if (focus.level === "moon") expect(moonR).toBeCloseTo(2.65, 6);
      }
    }
  });

  it("places Saturn's rings outside the planet and inside Enceladus", () => {
    const enc = getBody("enceladus");
    const orbit = enc.orbit;
    expect(orbit?.model).toBe("fixed");
    if (!orbit || orbit.model !== "fixed") return;
    const minKm = orbit.aKm * (1 - orbit.e);
    for (const focus of [
      { level: "planet", id: "saturn" },
      { level: "moon", id: "enceladus" },
      { level: "moon", id: "titan" },
    ] as const) {
      const rings = viewRingRadii(focus);
      expect(rings).not.toBeNull();
      if (!rings) continue;
      expect(rings.inner).toBeGreaterThan(viewBodyRadius("saturn", focus));
      expect(rings.outer).toBeGreaterThan(rings.inner);
      const encDist = parentRelativeDisplayDistance(minKm, focus);
      expect(rings.outer).toBeLessThan(encDist - viewBodyRadius("enceladus", focus));
    }
    expect(viewRingRadii({ level: "planet", id: "jupiter" })).toBeNull();
    expect(viewRingRadii({ level: "moon", id: "moon" })).toBeNull();
  });

  it("uses one radial map for body centers, orbit samples, and ship positions", () => {
    const t = 86_400 * 400;
    const focus = { level: "planet", id: "jupiter" } as const;
    const jupiter = position("jupiter", t);
    const io = position("io", t);
    const visual = viewOffset(io, t, focus);
    const physical = sub(io, jupiter);
    const crossed = cross(physical, visual);
    expect(norm(crossed)).toBeLessThan(1e-6 * norm(physical) * norm(visual));
    expect(dot(physical, visual)).toBeGreaterThan(0);
    expect(norm(visual)).toBeCloseTo(parentRelativeDisplayDistance(norm(physical), focus), 6);
    expect(norm(viewOffset(jupiter, t, focus))).toBeCloseTo(0, 6);
    // A point sitting on Io is the Io mesh center. The trail uses the same function.
    const again = viewOffset({ x: io.x, y: io.y, z: io.z }, t, focus);
    expect(again.x).toBeCloseTo(visual.x, 8);
    expect(again.y).toBeCloseTo(visual.y, 8);
    expect(again.z).toBeCloseTo(visual.z, 8);
    // Display units are not kilometers.
    expect(norm(visual)).toBeLessThan(100);
    expect(norm(physical)).toBeGreaterThan(100_000);
  });

  it("keeps Mars's moons on a true distance scale because they already fit", () => {
    const focus = { level: "planet", id: "mars" } as const;
    const phobos = getBody("phobos");
    const orbit = phobos.orbit;
    expect(orbit?.model).toBe("fixed");
    if (!orbit || orbit.model !== "fixed") return;
    const minKm = orbit.aKm * (1 - orbit.e);
    const dist = parentRelativeDisplayDistance(minKm, focus);
    const marsR = viewBodyRadius("mars", focus);
    expect(dist / marsR).toBeCloseTo(minKm / getBody("mars").radiusKm, 5);
    expect(marsR).toBeCloseTo(4, 6);
  });
});
