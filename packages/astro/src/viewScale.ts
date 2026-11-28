import { childBodies, getBody, position } from "./bodies.js";
import { AU_KM } from "./constants.js";
import { norm, scale, type Vec3 } from "./math.js";

/**
 * Display transform for the observer. Kepler states stay in kilometers; this
 * module only maps those positions and the catalog mean radii into a view.
 *
 * System view: heliocentric distance uses a square root (`16 * sqrt(au)`), so
 * Neptune still fits. Body radii keep their real ratios (Jupiter is about 11
 * Earth radii). A true Sun would hide the inner planets, so the photosphere is
 * capped to leave a gap outside Mercury at perihelion. It is still the largest body.
 *
 * Planet view: the parent is a fixed size. Moon radii keep their real ratio to
 * that parent. Distances from the parent use a power law so the outer moon sits
 * near the edge of the view, while the inner moon and Saturn's rings stay
 * outside the planet. The same function places ships and orbit samples.
 *
 * Moon view: that same local map, magnified until the focused moon is large
 * enough to read. The parent keeps the true radius ratio, so it has the right
 * angular size in the sky.
 */

export type ViewFocus =
  | { level: "system" }
  | { level: "planet"; id: string }
  | { level: "moon"; id: string };

/** `display = SCALE * au^EXPONENT`. Square root is the system-view compression. */
const SYSTEM_DISTANCE_SCALE = 16;
const SYSTEM_DISTANCE_EXPONENT = 0.5;

/** Earth radius in system-view units. Every other body scales from this by mean radius. */
const SYSTEM_EARTH_RADIUS = 0.28;

/**
 * Clear space outside the solar photosphere at Mercury's perihelion, as a
 * fraction of the Sun's display radius. Mercury's own radius sits in that gap.
 */
const SUN_PERIHELION_MARGIN = 0.35;

/** Parent-body radius in a planet focus, before a moon-focus magnification. */
const PLANET_VIEW_BODY_RADIUS = 4;

/** Display distance of the outermost moon in a planet focus. */
const PLANET_VIEW_OUTER_DISTANCE = 28;

/** Focused moon radius in a moon focus. The parent scales by the same factor. */
const MOON_VIEW_BODY_RADIUS = 2.65;

/**
 * Saturn's main ring annulus, km from the planet's center.
 * Inner edge is the D ring; outer edge is the A ring. NASA NSSDCA Saturnian
 * Rings Fact Sheet. The ring texture fades in across the faint inner edge.
 */
const SATURN_RING_INNER_KM = 66_900;
const SATURN_RING_OUTER_KM = 136_780;

function systemDistanceKm(km: number): number {
  if (!(km > 0)) return 0;
  const au = km / AU_KM;
  return SYSTEM_DISTANCE_SCALE * Math.pow(au, SYSTEM_DISTANCE_EXPONENT);
}

function systemViewOffset(km: Vec3): Vec3 {
  const r = norm(km);
  if (!(r > 0)) return { x: 0, y: 0, z: 0 };
  return scale(km, systemDistanceKm(r) / r);
}

function jplPair(id: string): { aAu: number; e: number } | null {
  const orbit = getBody(id).orbit;
  if (!orbit || orbit.model !== "jpl") return null;
  return { aAu: orbit.el[0] ?? 0, e: orbit.el[1] ?? 0 };
}

function mercuryPerihelionDisplay(): number {
  const el = jplPair("mercury");
  const au = el ? el.aAu * (1 - el.e) : 0.307;
  return systemDistanceKm(au * AU_KM);
}

function linearSystemRadius(id: string): number {
  const earthKm = getBody("earth").radiusKm;
  return SYSTEM_EARTH_RADIUS * (getBody(id).radiusKm / earthKm);
}

function systemBodyRadius(id: string): number {
  const linear = linearSystemRadius(id);
  if (id !== "sun") return linear;
  const peri = mercuryPerihelionDisplay();
  const mercuryR = linearSystemRadius("mercury");
  const cap = (peri - mercuryR) / (1 + SUN_PERIHELION_MARGIN);
  return Math.min(linear, Math.max(cap, 0));
}

function centerId(focus: ViewFocus): string {
  if (focus.level === "planet") return focus.id;
  if (focus.level === "moon") return getBody(focus.id).parentId ?? focus.id;
  return "sun";
}

/** Power on (distance / parent radius). 1 keeps true distances. */
function radialExponent(parentId: string): number {
  const parentR = getBody(parentId).radiusKm;
  if (!(parentR > 0)) return 1;
  let outerKm = 0;
  for (const moon of childBodies(parentId)) {
    const orbit = moon.orbit;
    if (orbit && orbit.model === "fixed") outerKm = Math.max(outerKm, orbit.aKm);
  }
  // Moonless worlds still compress a neighborhood so a parking orbit reads
  // and an interplanetary ship does not run off the number line.
  const ratio = outerKm > 0 ? outerKm / parentR : 36;
  const target = PLANET_VIEW_OUTER_DISTANCE / PLANET_VIEW_BODY_RADIUS;
  if (!(ratio > target)) return 1;
  return Math.log(target) / Math.log(ratio);
}

function magnification(focus: ViewFocus): number {
  if (focus.level !== "moon") return 1;
  const parent = getBody(focus.id).parentId;
  if (!parent) return 1;
  const atPlanetScale = PLANET_VIEW_BODY_RADIUS * (getBody(focus.id).radiusKm / getBody(parent).radiusKm);
  if (!(atPlanetScale > 0)) return 1;
  return MOON_VIEW_BODY_RADIUS / atPlanetScale;
}

function localDistance(parentId: string, distKm: number, mag: number): number {
  if (!(distKm > 0)) return 0;
  const parentR = getBody(parentId).radiusKm;
  if (!(parentR > 0)) return 0;
  return mag * PLANET_VIEW_BODY_RADIUS * Math.pow(distKm / parentR, radialExponent(parentId));
}

/** Display radius of a body in this focus. Centers still come from `viewOffset`. */
export function viewBodyRadius(id: string, focus: ViewFocus): number {
  if (focus.level === "system") return systemBodyRadius(id);
  const parent = centerId(focus);
  const parentR = getBody(parent).radiusKm;
  if (!(parentR > 0)) return 0;
  return magnification(focus) * PLANET_VIEW_BODY_RADIUS * (getBody(id).radiusKm / parentR);
}

/**
 * Display distance from the focused parent for a true separation of `distKm`.
 * Planet and moon focuses only. Monotonic in `distKm`, and equal to the parent
 * display radius when `distKm` is the parent's mean radius.
 */
export function parentRelativeDisplayDistance(distKm: number, focus: Exclude<ViewFocus, { level: "system" }>): number {
  return localDistance(centerId(focus), distKm, magnification(focus));
}

/** Saturn's rings in display units, or null when Saturn is not in this focus. */
export function viewRingRadii(focus: ViewFocus): { inner: number; outer: number } | null {
  if (focus.level === "system") {
    const bodyR = getBody("saturn").radiusKm;
    const shown = systemBodyRadius("saturn");
    return {
      inner: shown * (SATURN_RING_INNER_KM / bodyR),
      outer: shown * (SATURN_RING_OUTER_KM / bodyR),
    };
  }
  if (centerId(focus) !== "saturn") return null;
  const mag = magnification(focus);
  return {
    inner: localDistance("saturn", SATURN_RING_INNER_KM, mag),
    outer: localDistance("saturn", SATURN_RING_OUTER_KM, mag),
  };
}

/**
 * Ecliptic display offset for a heliocentric kilometer position.
 * System view is sun-centered and compressed. Planet and moon views are
 * parent-centered and use the local radial map, so a ship sample, an orbit
 * vertex, and the body mesh share one coordinate.
 */
export function viewOffset(helioKm: Vec3, t: number, focus: ViewFocus): Vec3 {
  if (focus.level === "system") return systemViewOffset(helioKm);
  const parent = centerId(focus);
  const origin = position(parent, t);
  const dx = helioKm.x - origin.x;
  const dy = helioKm.y - origin.y;
  const dz = helioKm.z - origin.z;
  const dist = Math.hypot(dx, dy, dz);
  const visual = localDistance(parent, dist, magnification(focus));
  if (!(dist > 0) || !(visual > 0)) return { x: 0, y: 0, z: 0 };
  const s = visual / dist;
  return { x: dx * s, y: dy * s, z: dz * s };
}
