import { planRoutes, simTimeToIso } from "@acs/astro";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { BUILD } from "./content.js";
import { ApiError, str } from "./errors.js";
import { Simulation, type GoodLine } from "./sim.js";

export interface AppOptions {
  dbPath: string;
  /** Live clock. Tests leave this off and call `sim.advance`. */
  tick?: boolean;
  now?: () => number;
}

export interface AppContext {
  app: FastifyInstance;
  sim: Simulation;
  close: () => Promise<void>;
}

interface SocketLike {
  send: (data: string) => void;
  on: (event: string, listener: () => void) => void;
}

function playbookPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../PLAY.md"),
    path.resolve(here, "../../PLAY.md"),
    path.resolve(process.cwd(), "PLAY.md"),
    path.resolve(process.cwd(), "../../PLAY.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`PLAY.md not found. Looked in ${candidates.join(", ")}`);
  return found;
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

export async function createApp(opts: AppOptions): Promise<AppContext> {
  const sim = new Simulation(opts.dbPath, opts.now);
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const sockets = new Set<SocketLike>();
  const broadcast = () => {
    const payload = JSON.stringify({ type: "world", snapshot: sim.snapshot() });
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
      }
    }
  };
  sim.onChange(broadcast);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send({ error: error.code, message: error.message, details: error.details ?? null });
    }
    const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
    const message = error instanceof Error ? error.message : "Request failed.";
    if (status >= 500) console.error(error);
    return reply.status(status).send({
      error: status >= 500 ? "internal" : "bad_request",
      message,
      details: null,
    });
  });

  const auth = (header: string | undefined) => {
    if (!header?.toLowerCase().startsWith("bearer ")) {
      throw new ApiError(
        401,
        "unauthorized",
        "Send header Authorization: Bearer <token>. Register with POST /api/corporations. The token is returned once.",
      );
    }
    return sim.corpByToken(header.slice(7).trim());
  };

  app.get("/api/health", async () => ({ ok: true, ...sim.clockView() }));
  app.get("/play.md", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return readFileSync(playbookPath(), "utf8");
  });
  app.get("/api/world/bodies", async () => sim.bodiesPayload());
  app.get("/api/world/snapshot", async () => sim.snapshot());
  app.get("/api/world/recipes", async () =>
    Object.entries(BUILD).map(([id, recipe]) => ({
      id,
      ...recipe,
    })),
  );
  app.get("/api/leaderboard", async () => sim.leaderboard());
  app.get("/api/markets/:bodyId", async (req) => sim.market((req.params as { bodyId: string }).bodyId));
  app.get("/api/corporations/:id", async (req) => sim.profile((req.params as { id: string }).id));
  app.get("/api/routes/plan", async (req) => {
    const query = req.query as { from?: string; to?: string; at?: string };
    const from = str(query.from, "from");
    const to = str(query.to, "to");
    const at = query.at === undefined || query.at === "" ? sim.simTime : Number(query.at);
    if (!Number.isFinite(at)) {
      throw new ApiError(400, "bad_number", "Query `at` must be a sim time in seconds since J2000. Omit it to plan from the current sim time.");
    }
    try {
      const options = planRoutes(from, to, at);
      return {
        from,
        to,
        at,
        iso: simTimeToIso(at),
        options: options.map((option) => ({
          kind: option.kind,
          deltaV: option.deltaV,
          deltaVDepart: option.deltaVDepart,
          deltaVArrive: option.deltaVArrive,
          propellantPerTonneDry: option.propellantPerTonneDry,
          propellantFractionOfWet: option.propellantFractionOfWet,
          referenceIspS: option.referenceIspS,
          departAt: option.departAt,
          arriveAt: option.arriveAt,
          tofSeconds: option.tofSeconds,
          frameId: option.frameId,
          points: option.points,
        })),
      };
    } catch (error) {
      throw new ApiError(400, "no_route", error instanceof Error ? error.message : "No route.");
    }
  });

  app.post("/api/corporations", async (req) => {
    const body = jsonBody(req.body);
    return sim.registerCorp(String(body.name ?? ""));
  });
  app.post("/api/sim/clock", async (req) => {
    const body = jsonBody(req.body);
    return sim.setClock({
      speed: body.speed === undefined ? undefined : Number(body.speed),
      paused: body.paused === undefined ? undefined : Boolean(body.paused),
    });
  });

  app.get("/api/me/briefing", async (req) => sim.briefing(auth(req.headers.authorization).id));
  app.get("/api/me/events", async (req) => {
    const corp = auth(req.headers.authorization);
    const since = Number((req.query as { since?: string }).since ?? 0);
    if (!Number.isFinite(since) || since < 0) {
      throw new ApiError(400, "bad_number", "Query `since` is the last event id you have seen. Use 0 to read from the start.");
    }
    return { events: sim.events(corp.id, since) };
  });

  app.post("/api/orders", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() =>
      sim.placeOrder(corp.id, {
        bodyId: String(body.bodyId ?? ""),
        commodity: String(body.commodity ?? ""),
        side: String(body.side ?? ""),
        quantity: Number(body.quantity),
        price: Number(body.price),
      }),
    );
  });
  app.delete("/api/orders/:id", async (req) => {
    const corp = auth(req.headers.authorization);
    const id = (req.params as { id: string }).id;
    sim.mutate(() => sim.cancelOrder(corp.id, id));
    return { ok: true };
  });
  app.post("/api/standing-orders", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() =>
      sim.placeStanding(corp.id, {
        bodyId: String(body.bodyId ?? ""),
        commodity: String(body.commodity ?? ""),
        side: String(body.side ?? ""),
        targetTons: Number(body.targetTons),
        limitPrice: Number(body.limitPrice),
        batchTons: Number(body.batchTons),
      }),
    );
  });
  app.delete("/api/standing-orders/:id", async (req) => {
    const corp = auth(req.headers.authorization);
    sim.mutate(() => sim.cancelStanding(corp.id, (req.params as { id: string }).id));
    return { ok: true };
  });

  app.post("/api/warehouses/:id/list", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    sim.mutate(() => sim.listWarehouse(corp.id, (req.params as { id: string }).id, Number(body.tons), Number(body.rate)));
    return { ok: true };
  });
  app.post("/api/space-bids", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() => sim.placeSpaceBid(corp.id, String(body.bodyId ?? ""), Number(body.tons), Number(body.maxRate)));
  });
  app.post("/api/leases", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() => sim.takeLease(corp.id, String(body.warehouseId ?? ""), Number(body.tons)));
  });
  app.post("/api/leases/:id/seize", async (req) => {
    const corp = auth(req.headers.authorization);
    return sim.mutate(() => sim.seizeLease(corp.id, (req.params as { id: string }).id));
  });
  app.post("/api/leases/:id/end", async (req) => {
    const corp = auth(req.headers.authorization);
    sim.mutate(() => sim.endLease(corp.id, (req.params as { id: string }).id));
    return { ok: true };
  });

  app.post("/api/assets/list", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    const price = body.price === null || body.price === undefined ? null : Number(body.price);
    sim.mutate(() => sim.listAsset(corp.id, String(body.assetType ?? ""), String(body.assetId ?? ""), price));
    return { ok: true };
  });
  app.post("/api/assets/buy", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() => sim.buyAsset(corp.id, String(body.assetType ?? ""), String(body.assetId ?? "")));
  });
  app.post("/api/construction", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() => sim.construct(corp.id, String(body.bodyId ?? ""), String(body.recipe ?? "")));
  });

  app.post("/api/ships/:id/load", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() => sim.loadShip(corp.id, (req.params as { id: string }).id, String(body.commodity ?? ""), Number(body.tons)));
  });
  app.post("/api/ships/:id/unload", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() => sim.unloadShip(corp.id, (req.params as { id: string }).id, String(body.commodity ?? ""), Number(body.tons)));
  });
  app.post("/api/ships/:id/launch", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    const preference = body.preference === undefined ? undefined : String(body.preference);
    return sim.mutate(() => sim.launch(corp.id, (req.params as { id: string }).id, String(body.toBodyId ?? ""), preference));
  });
  app.post("/api/ships/:id/cancel-launch", async (req) => {
    const corp = auth(req.headers.authorization);
    sim.mutate(() => sim.cancelLaunch(corp.id, (req.params as { id: string }).id));
    return { ok: true };
  });

  app.post("/api/messages", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    const bodyId = body.bodyId === undefined || body.bodyId === null ? undefined : String(body.bodyId);
    return sim.mutate(() => sim.sendMessage(corp.id, String(body.toCorpId ?? ""), String(body.text ?? ""), bodyId));
  });
  app.post("/api/offers", async (req) => {
    const corp = auth(req.headers.authorization);
    const body = jsonBody(req.body);
    return sim.mutate(() =>
      sim.createOffer(corp.id, {
        toCorpId: String(body.toCorpId ?? ""),
        bodyId: String(body.bodyId ?? ""),
        creditsOffered: body.creditsOffered === undefined ? 0 : Number(body.creditsOffered),
        creditsRequested: body.creditsRequested === undefined ? 0 : Number(body.creditsRequested),
        goodsOffered: (body.goodsOffered as GoodLine[] | undefined) ?? [],
        goodsRequested: (body.goodsRequested as GoodLine[] | undefined) ?? [],
        note: body.note === undefined ? undefined : String(body.note),
      }),
    );
  });
  app.post("/api/offers/:id/accept", async (req) => {
    const corp = auth(req.headers.authorization);
    sim.mutate(() => sim.acceptOffer(corp.id, (req.params as { id: string }).id));
    return { ok: true };
  });
  app.post("/api/offers/:id/reject", async (req) => {
    const corp = auth(req.headers.authorization);
    sim.mutate(() => sim.rejectOffer(corp.id, (req.params as { id: string }).id));
    return { ok: true };
  });
  app.post("/api/offers/:id/cancel", async (req) => {
    const corp = auth(req.headers.authorization);
    sim.mutate(() => sim.cancelOffer(corp.id, (req.params as { id: string }).id));
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, (socket: SocketLike) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "world", snapshot: sim.snapshot() }));
    socket.on("close", () => sockets.delete(socket));
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.tick !== false) {
    timer = setInterval(() => {
      try {
        sim.tick();
      } catch (error) {
        console.error("sim tick failed", error);
      }
    }, 400);
    timer.unref?.();
  }

  return {
    app,
    sim,
    close: async () => {
      if (timer) clearInterval(timer);
      await app.close();
      sim.close();
    },
  };
}
