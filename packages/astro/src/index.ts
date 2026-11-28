import { J2000_UNIX_MS } from "./constants.js";

export { AU_KM, CENTURY_S, DAY_S, DEFAULT_EPOCH_S, G0_KM_S2, J2000_UNIX_MS, MU_SUN, REFERENCE_ISP_S, YEAR_S } from "./constants.js";
export {
  BODIES,
  bodyState,
  childBodies,
  distanceKm,
  getBody,
  isAncestor,
  orbitalPeriodS,
  parkingRadiusKm,
  position,
  relativeState,
  stateInFrame,
  tryBody,
  velocity,
  type BodyDef,
  type BodyKind,
} from "./bodies.js";
export {
  circularVelocity,
  eccentricAnomaly,
  keplerState,
  propagate,
  propellantForDeltaV,
  rotatePerifocal,
  stateFromMeanAnomaly,
  stumpffC,
  stumpffS,
  type KeplerElements,
} from "./kepler.js";
export { lambert, type LambertSolution } from "./lambert.js";
export {
  add,
  clamp,
  cross,
  deg,
  dot,
  norm,
  normalize,
  rad,
  scale,
  sub,
  v,
  wrapPi,
  type Vec3,
} from "./math.js";
export {
  arcPosition,
  arcVelocity,
  planRoutes,
  specificEnergy,
  transferFrame,
  type FlightArc,
  type RouteOption,
} from "./routes.js";

export function simTimeToIso(simTimeS: number): string {
  const ms = J2000_UNIX_MS + simTimeS * 1000;
  return new Date(ms).toISOString();
}
