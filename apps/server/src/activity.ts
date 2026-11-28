/** Wall-clock activity, not sim time. Keep the same thresholds in apps/web/src/activity.ts. */
export const ACTIVITY_GREEN_MS = 5 * 60 * 1000;
export const ACTIVITY_YELLOW_MS = 10 * 60 * 1000;
/** At most one last-active write per corporation per this many milliseconds. */
export const ACTIVITY_WRITE_INTERVAL_MS = 5 * 1000;

export type ActivityBand = "green" | "yellow" | "red";

/**
 * Green: token used in the last 5 minutes (age <= 5 min).
 * Yellow: in the last 10 minutes.
 * Red: older than that, or the token has never been used.
 */
export function activityBand(lastActiveMs: number | null, nowMs: number): ActivityBand {
  if (lastActiveMs == null || !Number.isFinite(lastActiveMs) || !Number.isFinite(nowMs)) return "red";
  const age = nowMs - lastActiveMs;
  if (age <= ACTIVITY_GREEN_MS) return "green";
  if (age <= ACTIVITY_YELLOW_MS) return "yellow";
  return "red";
}
