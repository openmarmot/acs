/** Astronomical unit, km. */
export const AU_KM = 149597870.7;

/** Solar gravitational parameter, km^3/s^2. */
export const MU_SUN = 1.32712440018e11;

export const DAY_S = 86400;
export const YEAR_S = 365.25 * DAY_S;
/** Julian century in seconds. JPL element rates are per Julian century. */
export const CENTURY_S = 36525 * DAY_S;

/** Standard gravity, km/s^2. */
export const G0_KM_S2 = 9.80665e-3;

/**
 * Reference specific impulse for route propellant estimates.
 * 900 s is a near-current nuclear-thermal class engine (NERVA-like),
 * not a torch drive. Ships may override this with their own Isp.
 */
export const REFERENCE_ISP_S = 900;

/** Sim time zero is J2000.0 (2000-01-01 12:00 TT, treated as UTC). */
export const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** A fresh universe starts at 2026-01-01 00:00 UTC. */
export const DEFAULT_EPOCH_S = (Date.UTC(2026, 0, 1, 0, 0, 0) - J2000_UNIX_MS) / 1000;
