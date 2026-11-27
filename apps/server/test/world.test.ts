import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
