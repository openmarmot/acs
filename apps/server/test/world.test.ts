import { readFileSync, mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_GREEN_MS, ACTIVITY_WRITE_INTERVAL_MS, ACTIVITY_YELLOW_MS, activityBand } from "../src/activity.js";
import { openDatabase } from "../src/db.js";
import { createApp, type AppContext } from "../src/http.js";

const open: AppContext[] = [];

async function boot(now?: () => number): Promise<AppContext> {
  const dir = mkdtempSync(path.join(tmpdir(), "acs-"));
  const ctx = await createApp({ dbPath: path.join(dir, "acs.db"), tick: false, now });
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  while (open.length) {
    const ctx = open.pop();
    if (ctx) await ctx.close();
  }
});

async function register(ctx: AppContext, name: string): Promise<{ token: string; id: string; credits: number }> {
  const res = await ctx.app.inject({ method: "POST", url: "/api/corporations", payload: { name } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  return { token: body.token, id: body.corporation.id, credits: body.corporation.credits };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("acs world", () => {
  it("serves the playbook and rejects a missing token", async () => {
    const ctx = await boot();
    const play = await ctx.app.inject({ method: "GET", url: "/play.md" });
    expect(play.statusCode).toBe(200);
    expect(play.body).toContain("/api/corporations");
    expect(play.body).toContain("curl");
    const briefing = await ctx.app.inject({ method: "GET", url: "/api/me/briefing" });
    expect(briefing.statusCode).toBe(401);
    expect(briefing.json().message).toMatch(/Bearer/);
    const missing = await ctx.app.inject({ method: "GET", url: "/api/no-such" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("not_found");
    const home = await ctx.app.inject({ method: "GET", url: "/" });
    if (home.statusCode === 200) {
      expect(String(home.headers["content-type"])).toMatch(/html/);
      expect(home.body).toContain("ACS");
    } else {
      expect(home.statusCode).toBe(404);
    }
    const escaped = await ctx.app.inject({ method: "GET", url: "/../package.json" });
    expect(escaped.body).not.toContain("\"name\": \"acs\"");
  });

  it("keeps corporations and the sim clock across a restart, ignoring downtime", async () => {
    let wall = 1_700_000_000_000;
    const dir = mkdtempSync(path.join(tmpdir(), "acs-"));
    const dbPath = path.join(dir, "acs.db");
    const first = await createApp({ dbPath, tick: false, now: () => wall });
    const created = await register(first, "Persistence Mining");
    const before = first.sim.simTime;
    await first.close();
    wall += 120_000;
    const second = await createApp({ dbPath, tick: false, now: () => wall });
    open.push(second);
    expect(Math.abs(second.sim.simTime - before)).toBeLessThan(1);
    const briefing = await second.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(created.token) });
    expect(briefing.statusCode).toBe(200);
    expect(briefing.json().corp.name).toBe("Persistence Mining");
  });

  it("buys a starter ship and a listed facility", async () => {
    const ctx = await boot();
    const corp = await register(ctx, "Kepler Cartage");
    const earth = await ctx.app.inject({ method: "GET", url: "/api/markets/earth" });
    const ship = earth.json().assets.find((asset: { assetType: string }) => asset.assetType === "ship");
    expect(ship).toBeTruthy();
    const bought = await ctx.app.inject({
      method: "POST",
      url: "/api/assets/buy",
      headers: auth(corp.token),
      payload: { assetType: "ship", assetId: ship.assetId },
    });
    expect(bought.statusCode, bought.body).toBe(200);
    const moon = await ctx.app.inject({ method: "GET", url: "/api/markets/moon" });
    const facility = moon.json().assets.find((asset: { assetType: string }) => asset.assetType === "facility");
    expect(facility).toBeTruthy();
    const boughtFac = await ctx.app.inject({
      method: "POST",
      url: "/api/assets/buy",
      headers: auth(corp.token),
      payload: { assetType: "facility", assetId: facility.assetId },
    });
    expect(boughtFac.statusCode, boughtFac.body).toBe(200);
    const briefing = await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(corp.token) });
    const sites = briefing.json().sites as Array<{ ships: unknown[]; facilities: Array<{ id: string }> }>;
    expect(sites.some((site) => site.ships.length > 0)).toBe(true);
    expect(sites.some((site) => site.facilities.some((fac) => fac.id === facility.assetId))).toBe(true);
    expect(briefing.json().corp.population).toBeGreaterThan(0);
  });

  it("rents warehouse space and pays rent as time advances", async () => {
    const ctx = await boot();
    const corp = await register(ctx, "Bay and Bale");
    const market = await ctx.app.inject({ method: "GET", url: "/api/markets/earth" });
    const ask = market.json().space.asks[0];
    expect(ask.tons).toBeGreaterThan(50);
    const before = (await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(corp.token) })).json().corp.credits as number;
    const lease = await ctx.app.inject({
      method: "POST",
      url: "/api/leases",
      headers: auth(corp.token),
      payload: { warehouseId: ask.warehouseId, tons: 50 },
    });
    expect(lease.statusCode, lease.body).toBe(200);
    ctx.sim.advance(86400);
    const briefing = await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(corp.token) });
    const site = briefing.json().sites.find((row: { bodyId: string }) => row.bodyId === "earth");
    expect(site.freeStorageTons).toBeGreaterThanOrEqual(50);
    expect(site.leases[0].tons).toBe(50);
    const expected = 50 * ask.rate;
    expect(before - briefing.json().corp.credits).toBeCloseTo(expected, 4);
  });

  it("fills a local market order and settles a bilateral deal at the same body", async () => {
    const ctx = await boot();
    const alpha = await register(ctx, "Alpha Exchange");
    const beta = await register(ctx, "Beta Exchange");
    const market = await ctx.app.inject({ method: "GET", url: "/api/markets/earth" });
    const ask = market.json().space.asks[0];
    const prop = market.json().commodities.propellant.asks[0];
    expect(prop.price).toBeGreaterThan(0);
    for (const token of [alpha.token, beta.token]) {
      const lease = await ctx.app.inject({
        method: "POST",
        url: "/api/leases",
        headers: auth(token),
        payload: { warehouseId: ask.warehouseId, tons: 40 },
      });
      expect(lease.statusCode, lease.body).toBe(200);
    }
    const buy = await ctx.app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(alpha.token),
      payload: { bodyId: "earth", commodity: "propellant", side: "buy", quantity: 12, price: prop.price },
    });
    expect(buy.statusCode, buy.body).toBe(200);
    expect(buy.json().filled).toBeCloseTo(12, 4);
    const offer = await ctx.app.inject({
      method: "POST",
      url: "/api/offers",
      headers: auth(alpha.token),
      payload: {
        toCorpId: beta.id,
        bodyId: "earth",
        goodsOffered: [{ commodity: "propellant", tons: 4 }],
        creditsRequested: 1500,
        note: "four tonnes, earth side",
      },
    });
    expect(offer.statusCode, offer.body).toBe(200);
    const accept = await ctx.app.inject({
      method: "POST",
      url: `/api/offers/${offer.json().id}/accept`,
      headers: auth(beta.token),
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const alphaBrief = (await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(alpha.token) })).json();
    const betaBrief = (await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(beta.token) })).json();
    const alphaEarth = alphaBrief.sites.find((site: { bodyId: string }) => site.bodyId === "earth");
    const betaEarth = betaBrief.sites.find((site: { bodyId: string }) => site.bodyId === "earth");
    expect(alphaEarth.inventory.propellant).toBeCloseTo(8, 4);
    expect(betaEarth.inventory.propellant).toBeCloseTo(4, 4);
    expect(betaBrief.corp.credits).toBeLessThan(beta.credits);
    expect(alphaBrief.corp.credits).toBeGreaterThan(0);
  });

  it("refuses an underfueled launch with a corrective message, then flies a fueled ship to arrival", async () => {
    const ctx = await boot();
    const corp = await register(ctx, "Transit Line");
    const market = await ctx.app.inject({ method: "GET", url: "/api/markets/earth" });
    const ship = market.json().assets.find((asset: { assetType: string }) => asset.assetType === "ship");
    const ask = market.json().space.asks[0];
    const bought = await ctx.app.inject({
      method: "POST",
      url: "/api/assets/buy",
      headers: auth(corp.token),
      payload: { assetType: "ship", assetId: ship.assetId },
    });
    expect(bought.statusCode, bought.body).toBe(200);
    const leased = await ctx.app.inject({
      method: "POST",
      url: "/api/leases",
      headers: auth(corp.token),
      payload: { warehouseId: ask.warehouseId, tons: 200 },
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const dumped = await ctx.app.inject({
      method: "POST",
      url: `/api/ships/${ship.assetId}/unload`,
      headers: auth(corp.token),
      payload: { commodity: "propellant", tons: 160 },
    });
    expect(dumped.statusCode, dumped.body).toBe(200);
    const dry = await ctx.app.inject({
      method: "POST",
      url: `/api/ships/${ship.assetId}/launch`,
      headers: auth(corp.token),
      payload: { toBodyId: "moon", preference: "min_delta_v" },
    });
    expect(dry.statusCode).toBe(400);
    expect(dry.json().error).toBe("insufficient_propellant");
    expect(dry.json().message).toMatch(/propellant/i);
    expect(dry.json().message).toMatch(/load/i);

    const reloaded = await ctx.app.inject({
      method: "POST",
      url: `/api/ships/${ship.assetId}/load`,
      headers: auth(corp.token),
      payload: { commodity: "propellant", tons: 160 },
    });
    expect(reloaded.statusCode, reloaded.body).toBe(200);
    const launch = await ctx.app.inject({
      method: "POST",
      url: `/api/ships/${ship.assetId}/launch`,
      headers: auth(corp.token),
      payload: { toBodyId: "moon", preference: "min_delta_v" },
    });
    expect(launch.statusCode, launch.body).toBe(200);
    const plan = launch.json();
    expect(plan.arriveAt).toBeGreaterThan(plan.departAt);
    ctx.sim.advance(plan.arriveAt - ctx.sim.simTime + 10);
    const briefing = await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(corp.token) });
    const moon = briefing.json().sites.find((site: { bodyId: string }) => site.bodyId === "moon");
    expect(moon).toBeTruthy();
    expect(moon.ships.some((row: { id: string; state: string }) => row.id === ship.assetId && row.state === "orbiting")).toBe(true);
    const events = await ctx.app.inject({ method: "GET", url: "/api/me/events?since=0", headers: auth(corp.token) });
    expect(events.json().events.some((event: { type: string }) => event.type === "arrival")).toBe(true);
  });

  it("classifies last-active age at 5 and 10 minutes", () => {
    expect(ACTIVITY_GREEN_MS).toBe(5 * 60 * 1000);
    expect(ACTIVITY_YELLOW_MS).toBe(10 * 60 * 1000);
    expect(ACTIVITY_WRITE_INTERVAL_MS).toBeGreaterThanOrEqual(2_000);
    expect(ACTIVITY_WRITE_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    const t0 = 1_700_000_000_000;
    expect(activityBand(null, t0)).toBe("red");
    expect(activityBand(Number.NaN, t0)).toBe("red");
    expect(activityBand(t0, t0)).toBe("green");
    expect(activityBand(t0, t0 + ACTIVITY_GREEN_MS)).toBe("green");
    expect(activityBand(t0, t0 + ACTIVITY_GREEN_MS + 1)).toBe("yellow");
    expect(activityBand(t0, t0 + ACTIVITY_YELLOW_MS)).toBe("yellow");
    expect(activityBand(t0, t0 + ACTIVITY_YELLOW_MS + 1)).toBe("red");
    const observer = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/activity.ts"), "utf8");
    expect(observer).toContain("5 * 60 * 1000");
    expect(observer).toContain("10 * 60 * 1000");
    expect(observer).toContain("never connected");
    expect(observer).toContain("active ${minutes} min ago");
  });

  it("records last activity when a token is used and throttles the write", async () => {
    let wall = 1_700_000_000_000;
    const ctx = await boot(() => wall);
    const corp = await register(ctx, "Signal Corps");
    const other = await register(ctx, "Quiet Books");

    const row = async (id: string) => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/leaderboard" });
      expect(res.statusCode).toBe(200);
      const found = res.json().find((entry: { id: string }) => entry.id === id);
      expect(found).toBeTruthy();
      return found as { id: string; lastActiveMs: number | null };
    };

    expect((await row(corp.id)).lastActiveMs).toBeNull();
    expect((await row(other.id)).lastActiveMs).toBeNull();

    const briefing = await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(corp.token) });
    expect(briefing.statusCode).toBe(200);
    expect((await row(corp.id)).lastActiveMs).toBe(wall);
    expect((await row(other.id)).lastActiveMs).toBeNull();
    expect(activityBand(wall, wall)).toBe("green");

    const stamped = wall;
    wall += ACTIVITY_WRITE_INTERVAL_MS - 1;
    const events = await ctx.app.inject({ method: "GET", url: "/api/me/events?since=0", headers: auth(corp.token) });
    expect(events.statusCode).toBe(200);
    expect((await row(corp.id)).lastActiveMs).toBe(stamped);

    wall += 1;
    const denied = await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth("acs_not_a_token") });
    expect(denied.statusCode).toBe(401);
    const revealed = await ctx.app.inject({ method: "GET", url: `/api/corporations/${corp.id}/token` });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toEqual({ id: corp.id, name: "Signal Corps", token: corp.token });
    expect((await row(corp.id)).lastActiveMs).toBe(stamped);

    const missed = await ctx.app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(corp.token),
      payload: {},
    });
    expect(missed.statusCode).toBe(400);
    expect((await row(corp.id)).lastActiveMs).toBe(wall);

    const snapshot = await ctx.app.inject({ method: "GET", url: "/api/world/snapshot" });
    const profile = await ctx.app.inject({ method: "GET", url: `/api/corporations/${corp.id}` });
    expect(snapshot.json().leaderboard.find((entry: { id: string }) => entry.id === corp.id).lastActiveMs).toBe(wall);
    expect(profile.json().lastActiveMs).toBe(wall);
    expect(snapshot.body).not.toContain(corp.token);
    expect(profile.body).not.toContain(corp.token);
    expect((await ctx.app.inject({ method: "GET", url: "/api/leaderboard" })).body).not.toContain(corp.token);

    wall += 50;
    const otherBrief = await ctx.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(other.token) });
    expect(otherBrief.statusCode).toBe(200);
    expect((await row(other.id)).lastActiveMs).toBe(wall);
    expect((await row(corp.id)).lastActiveMs).toBe(wall - 50);
  });

  it("keeps a previously issued token working after a stored token is added", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acs-"));
    const dbPath = path.join(dir, "acs.db");
    const first = await createApp({ dbPath, tick: false, now: () => 5_000 });
    const created = await register(first, "Old Token Mining");
    await first.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE corporations SET token = NULL WHERE id = ?").run(created.id);
    raw.close();

    const second = await createApp({ dbPath, tick: false, now: () => 9_000 });
    open.push(second);
    const briefing = await second.app.inject({ method: "GET", url: "/api/me/briefing", headers: auth(created.token) });
    expect(briefing.statusCode, briefing.body).toBe(200);
    expect(briefing.json().corp.name).toBe("Old Token Mining");

    const revealed = await second.app.inject({ method: "GET", url: `/api/corporations/${created.id}/token` });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().token).not.toBe(created.token);
    expect(String(revealed.json().token)).toMatch(/^acs_[0-9a-f]+$/);
    const again = await second.app.inject({
      method: "GET",
      url: "/api/me/briefing",
      headers: auth(revealed.json().token as string),
    });
    expect(again.statusCode, again.body).toBe(200);
    const board = await second.app.inject({ method: "GET", url: "/api/leaderboard" });
    expect(board.json().find((entry: { id: string }) => entry.id === created.id).lastActiveMs).toBe(9_000);
  });

  it("adds token and last-active columns when opening an older database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acs-"));
    const dbPath = path.join(dir, "acs.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE corporations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      credits REAL NOT NULL,
      reserved_credits REAL NOT NULL DEFAULT 0,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_sim_time REAL NOT NULL
    )`);
    raw.prepare(
      "INSERT INTO corporations (id, name, token_hash, credits, reserved_credits, legacy, created_sim_time) VALUES (?, ?, ?, ?, 0, 0, 0)",
    ).run("corp_old", "Old Books", "abc", 1);
    raw.close();

    const db = openDatabase(dbPath);
    const names = (db.prepare("PRAGMA table_info(corporations)").all() as { name: string }[]).map((column) => column.name);
    expect(names).toContain("token");
    expect(names).toContain("last_active_ms");
    const row = db.prepare("SELECT name, token, last_active_ms FROM corporations WHERE id = ?").get("corp_old") as {
      name: string;
      token: string | null;
      last_active_ms: number | null;
    };
    expect(row).toEqual({ name: "Old Books", token: null, last_active_ms: null });
    db.close();
  });
});
