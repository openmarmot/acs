import { createHash, randomBytes } from "node:crypto";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function nid(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export function newToken(): string {
  return `acs_${randomBytes(24).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tons(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function num(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new ApiError(400, "bad_number", `${label} must be a finite number. Received ${JSON.stringify(value)}.`);
  }
  return n;
}

export function pos(value: unknown, label: string): number {
  const n = num(value, label);
  if (n <= 0) {
    throw new ApiError(400, "bad_number", `${label} must be greater than 0. Received ${n}.`);
  }
  return n;
}

export function str(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "bad_string", `${label} must be a non-empty string.`);
  }
  return value.trim();
}
