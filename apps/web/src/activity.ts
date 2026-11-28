/** Wall-clock activity, not sim time. Keep the same thresholds in apps/server/src/activity.ts. */
export const ACTIVITY_GREEN_MS = 5 * 60 * 1000;
export const ACTIVITY_YELLOW_MS = 10 * 60 * 1000;

export type ActivityBand = "green" | "yellow" | "red";

/** Green within 5 minutes, yellow within 10, red after that or when there is no timestamp. */
export function activityBand(lastActiveMs: number | null, nowMs: number): ActivityBand {
  if (lastActiveMs == null || !Number.isFinite(lastActiveMs) || !Number.isFinite(nowMs)) return "red";
  const age = nowMs - lastActiveMs;
  if (age <= ACTIVITY_GREEN_MS) return "green";
  if (age <= ACTIVITY_YELLOW_MS) return "yellow";
  return "red";
}

/** Plain words for the corporation screen. Examples: "active 2 min ago", "never connected". */
export function activityPhrase(lastActiveMs: number | null, nowMs: number): string {
  if (lastActiveMs == null || !Number.isFinite(lastActiveMs) || !Number.isFinite(nowMs)) return "never connected";
  const age = Math.max(0, nowMs - lastActiveMs);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "active just now";
  if (minutes < 60) return minutes === 1 ? "active 1 min ago" : `active ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "active 1 hr ago" : `active ${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "active 1 day ago" : `active ${days} days ago`;
}
