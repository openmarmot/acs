import {
  BODIES,
  DEFAULT_EPOCH_S,
  planRoutes,
  propellantForDeltaV,
  simTimeToIso,
  tryBody,
  type RouteOption,
} from "@acs/astro";
import type { DatabaseSync } from "node:sqlite";
import {
  BUILD,
  COMMODITIES,
  DEPOSITS,
  ELEC_PER_PERSON_DAY,
  FEE,
  GRACE_S,
  LIFE_PER_PERSON_DAY,
  MINE_OUTPUT,
  PARTS_PER_FACILITY_DAY,
  PARTS_PER_SHIP_DAY,
  SHIP_CLASSES,
  STARTING_CREDITS,
  TRANSFORMS,
  WORKERS,
  DEFAULT_SPEED,
  depositOf,
  isCommodity,
  type Commodity,
} from "./content.js";
import { all, get, openDatabase, run } from "./db.js";
import { ApiError, hashToken, newToken, nid, pos, str, tons } from "./errors.js";

interface Corp {
  id: string;
  name: string;
  token_hash: string;
  credits: number;
  reserved_credits: number;
  legacy: number;
  created_sim_time: number;
}

interface Container {
  id: string;
  kind: string;
  body_id: string;
  owner_corp_id: string;
  capacity_tons: number;
  warehouse_id: string | null;
  lease_id: string | null;
  ship_id: string | null;
}

interface Lot {
  id: string;
  container_id: string;
  commodity: string;
  tons: number;
  reserved_tons: number;
}

interface Ship {
  id: string;
  owner_corp_id: string;
  name: string;
  class: string;
  state: string;
  body_id: string;
  dry_mass_tons: number;
  isp_s: number;
  tank_tons: number;
  tank_capacity: number;
  cargo_capacity: number;
  crew: number;
  ask_price: number | null;
  flight_json: string | null;
  created_sim_time: number;
}

interface Facility {
  id: string;
  body_id: string;
  owner_corp_id: string;
  kind: string;
  name: string;
  capacity: number;
  active: number;
  ask_price: number | null;
  condition: number;
  created_sim_time: number;
}

interface Warehouse {
  id: string;
  body_id: string;
  owner_corp_id: string;
  name: string;
  capacity_tons: number;
  listed_tons: number;
  listed_rate: number | null;
  ask_price: number | null;
  created_sim_time: number;
}

interface Order {
  id: string;
  body_id: string;
  corp_id: string;
  commodity: string;
  side: string;
  qty_remaining: number;
  price: number;
  status: string;
  standing_id: string | null;
  created_sim_time: number;
}

interface Lease {
  id: string;
  warehouse_id: string;
  tenant_corp_id: string;
  tons: number;
  rate_per_ton_day: number;
  accrued_unpaid: number;
  unpaid_since: number | null;
  status: string;
  created_sim_time: number;
}

export interface GoodLine {
  commodity: string;
  tons: number;
}

export interface FlightPlan {
  toBodyId: string;
  fromBodyId: string;
  departAt: number;
  arriveAt: number;
  deltaV: number;
  deltaVDepart: number;
  deltaVArrive: number;
  burnedTons: number;
  frameId: string;
  mu: number;
  r0: [number, number, number];
  v0: [number, number, number];
  preference: string;
  propellantPerTonneDry: number;
}

type Listener = () => void;

export class Simulation {
  readonly db: DatabaseSync;
  simTime: number;
  speed: number;
  paused: boolean;
  lastWall: number;
  readonly nowMs: () => number;
  readonly listeners = new Set<Listener>();
  private depth = 0;
  private shortageDays = new Set<string>();

  constructor(dbPath: string, nowMs: () => number = Date.now) {
    this.db = openDatabase(dbPath);
    this.nowMs = nowMs;
    const clock = get<{ sim_time: number; speed: number; paused: number }>(this.db, "SELECT * FROM clock WHERE id = 1");
    if (!clock) {
      this.simTime = DEFAULT_EPOCH_S;
      this.speed = DEFAULT_SPEED;
      this.paused = false;
      run(this.db, "INSERT INTO clock (id, sim_time, speed, paused) VALUES (1, ?, ?, 0)", this.simTime, this.speed);
    } else {
      this.simTime = clock.sim_time;
      this.speed = clock.speed;
      this.paused = clock.paused === 1;
    }
    this.lastWall = this.nowMs();
    const seeded = get<{ value: string }>(this.db, "SELECT value FROM meta WHERE key = 'seeded'");
    if (!seeded) this.tx(() => this.seed());
  }

  close(): void {
    this.persistClock();
    this.db.close();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.depth--;
      return result;
    } catch (error) {
      this.depth--;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  private savepoint<T>(name: string, fn: () => T): T {
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  mutate<T>(fn: () => T): T {
    const result = this.tx(fn);
    this.emit();
    return result;
  }

  /** Wall-clock tick. Downtime is not applied: lastWall is reset on startup. */
  tick(): void {
    const wall = this.nowMs();
    if (!this.paused) {
      let dt = ((wall - this.lastWall) / 1000) * this.speed;
      if (dt > 30 * 86400) dt = 30 * 86400;
      if (dt > 1e-6) this.advance(dt);
    }
    this.lastWall = wall;
    this.persistClock();
    this.emit();
  }

  advance(dt: number): void {
    if (dt <= 0) return;
    let left = dt;
    while (left > 1e-6) {
      const step = Math.min(left, 6 * 3600);
      this.tx(() => {
        this.simTime += step;
        this.persistClock();
        this.departShips();
        this.arriveShips();
        this.finishConstruction();
        this.economy(step);
        this.syncStanding();
        this.matchAll();
      });
      left -= step;
    }
    this.emit();
  }

  private persistClock(): void {
    run(
      this.db,
      "UPDATE clock SET sim_time = ?, speed = ?, paused = ? WHERE id = 1",
      this.simTime,
      this.speed,
      this.paused ? 1 : 0,
    );
  }

  setClock(input: { speed?: number; paused?: boolean }): { simTime: number; speed: number; paused: boolean; iso: string } {
    return this.mutate(() => {
      if (input.speed !== undefined) {
        if (!Number.isFinite(input.speed) || input.speed < 0 || input.speed > 1_000_000) {
          throw new ApiError(400, "bad_speed", "speed must be a number from 0 to 1000000. Examples: 1 (real-time), 60, 240, 10000.");
        }
        this.speed = input.speed;
      }
      if (input.paused !== undefined) this.paused = input.paused;
      this.lastWall = this.nowMs();
      this.persistClock();
      this.log("clock", `Sim clock ${this.paused ? "paused" : "running"} at ${this.speed}x.`, { public: true });
      return this.clockView();
    });
  }

  clockView(): { simTime: number; speed: number; paused: boolean; iso: string } {
    return { simTime: this.simTime, speed: this.speed, paused: this.paused, iso: simTimeToIso(this.simTime) };
  }

  // --- identity ----------------------------------------------------------------

  registerCorp(nameRaw: string): { corporation: { id: string; name: string; credits: number }; token: string } {
    const name = str(nameRaw, "name");
    if (!/^[A-Za-z0-9][A-Za-z0-9 .'\-]{1,38}$/.test(name)) {
      throw new ApiError(
        400,
        "bad_name",
        "Corporation name must be 2–39 characters and start with a letter or number (letters, numbers, spaces, apostrophes, dots, hyphens).",
      );
    }
    return this.mutate(() => {
      const existing = get(this.db, "SELECT id FROM corporations WHERE name = ?", name);
      if (existing) {
        throw new ApiError(409, "name_taken", `A corporation named "${name}" already exists. Pick a different name.`);
      }
      const id = nid("corp");
      const token = newToken();
      run(
        this.db,
        "INSERT INTO corporations (id, name, token_hash, credits, reserved_credits, legacy, created_sim_time) VALUES (?, ?, ?, ?, 0, 0, ?)",
        id,
        name,
        hashToken(token),
        STARTING_CREDITS,
        this.simTime,
      );
      this.log("corp_founded", `${name} was founded.`, { corpId: id, public: true, payload: { id, name } });
      return { corporation: { id, name, credits: STARTING_CREDITS }, token };
    });
  }

  corpByToken(token: string): Corp {
    const row = get<Corp>(this.db, "SELECT * FROM corporations WHERE token_hash = ?", hashToken(token));
    if (!row) {
      throw new ApiError(
        401,
        "unauthorized",
        "That bearer token does not match a corporation. Register with POST /api/corporations and store the token it returns. The token is shown only once.",
      );
    }
    return row;
  }

  requireCorp(id: string): Corp {
    const row = get<Corp>(this.db, "SELECT * FROM corporations WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No corporation ${id}.`);
    return row;
  }

  // --- storage -----------------------------------------------------------------

  private groundContainers(corpId: string, bodyId: string): Container[] {
    const rows = all<Container>(this.db, "SELECT * FROM containers WHERE owner_corp_id = ? AND body_id = ?", corpId, bodyId);
    return rows.filter((c) => {
      if (c.kind !== "hold" || !c.ship_id) return true;
      const ship = get<Ship>(this.db, "SELECT * FROM ships WHERE id = ?", c.ship_id);
      return !!ship && ship.state === "orbiting";
    });
  }

  private storedTons(containerId: string): number {
    const row = get<{ s: number }>(this.db, "SELECT COALESCE(SUM(tons), 0) AS s FROM lots WHERE container_id = ?", containerId);
    return row?.s ?? 0;
  }

  private freeIn(container: Container): number {
    return Math.max(0, container.capacity_tons - this.storedTons(container.id));
  }

  freeStorage(corpId: string, bodyId: string): number {
    return this.groundContainers(corpId, bodyId).reduce((sum, c) => sum + this.freeIn(c), 0);
  }

  private available(corpId: string, bodyId: string, commodity: string): number {
    let sum = 0;
    for (const c of this.groundContainers(corpId, bodyId)) {
      const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ? AND commodity = ?", c.id, commodity);
      if (lot) sum += Math.max(0, lot.tons - lot.reserved_tons);
    }
    return sum;
  }

  private inventoryMap(corpId: string, bodyId: string): Record<string, number> {
    const map: Record<string, number> = {};
    for (const c of this.groundContainers(corpId, bodyId)) {
      for (const lot of all<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ?", c.id)) {
        map[lot.commodity] = tons((map[lot.commodity] ?? 0) + lot.tons);
      }
    }
    return map;
  }

  private addCommodity(containerId: string, commodity: string, amount: number): void {
    const qty = tons(amount);
    if (qty <= 0) return;
    const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ? AND commodity = ?", containerId, commodity);
    if (lot) run(this.db, "UPDATE lots SET tons = ? WHERE id = ?", tons(lot.tons + qty), lot.id);
    else run(this.db, "INSERT INTO lots (id, container_id, commodity, tons, reserved_tons) VALUES (?, ?, ?, ?, 0)", nid("lot"), containerId, commodity, qty);
  }

  private takeAvailable(containerId: string, commodity: string, want: number): number {
    const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ? AND commodity = ?", containerId, commodity);
    if (!lot) return 0;
    const got = tons(Math.min(Math.max(0, lot.tons - lot.reserved_tons), want));
    if (got <= 0) return 0;
    const left = tons(lot.tons - got);
    if (left <= 1e-9) run(this.db, "DELETE FROM lots WHERE id = ?", lot.id);
    else run(this.db, "UPDATE lots SET tons = ? WHERE id = ?", left, lot.id);
    return got;
  }

  private draw(corpId: string, bodyId: string, commodity: string, want: number, excludeShipId?: string): number {
    let need = want;
    let got = 0;
    for (const c of this.groundContainers(corpId, bodyId)) {
      if (need <= 1e-9) break;
      if (excludeShipId && c.ship_id === excludeShipId) continue;
      const part = this.takeAvailable(c.id, commodity, need);
      got += part;
      need -= part;
    }
    return tons(got);
  }

  private drawHold(shipId: string, commodity: string, want: number): number {
    const hold = get<Container>(this.db, "SELECT * FROM containers WHERE ship_id = ? AND kind = 'hold'", shipId);
    if (!hold) return 0;
    return this.takeAvailable(hold.id, commodity, want);
  }

  private storeOutput(corpId: string, bodyId: string, commodity: string, amount: number): number {
    let left = amount;
    const containers = [...this.groundContainers(corpId, bodyId)].sort((a, b) => this.kindRank(a.kind) - this.kindRank(b.kind));
    for (const c of containers) {
      if (left <= 1e-9) break;
      const room = this.freeIn(c);
      const put = Math.min(room, left);
      if (put > 1e-9) {
        this.addCommodity(c.id, commodity, put);
        left -= put;
      }
    }
    return tons(amount - left);
  }

  private kindRank(kind: string): number {
    if (kind === "warehouse_owner") return 0;
    if (kind === "bay") return 1;
    return 2;
  }

  private holdMass(shipId: string): number {
    const hold = get<Container>(this.db, "SELECT * FROM containers WHERE ship_id = ? AND kind = 'hold'", shipId);
    if (!hold) return 0;
    return this.storedTons(hold.id);
  }

  private reserveLots(corpId: string, bodyId: string, commodity: string, amount: number, ref: { orderId?: string; offerId?: string }): void {
    let need = amount;
    for (const c of this.groundContainers(corpId, bodyId)) {
      if (need <= 1e-9) break;
      const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ? AND commodity = ?", c.id, commodity);
      if (!lot) continue;
      const free = Math.max(0, lot.tons - lot.reserved_tons);
      const take = tons(Math.min(free, need));
      if (take <= 0) continue;
      run(this.db, "UPDATE lots SET reserved_tons = ? WHERE id = ?", tons(lot.reserved_tons + take), lot.id);
      run(
        this.db,
        "INSERT INTO reservations (id, order_id, offer_id, lot_id, corp_id, tons, credits, commodity) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        nid("res"),
        ref.orderId ?? null,
        ref.offerId ?? null,
        lot.id,
        corpId,
        take,
        commodity,
      );
      need -= take;
    }
    if (need > 1e-4) {
      throw new ApiError(
        400,
        "insufficient_goods",
        `Need ${tons(amount)} t of ${commodity} at ${bodyId} but only ${tons(amount - need)} t is unreserved. Buy or unload more, or lower the quantity.`,
        { commodity, bodyId, needed: amount, available: tons(amount - need) },
      );
    }
  }

  private releaseOrderReservations(order: Order): void {
    const rows = all<{ id: string; lot_id: string; tons: number; credits: number }>(
      this.db,
      "SELECT * FROM reservations WHERE order_id = ?",
      order.id,
    );
    for (const res of rows) {
      if (res.lot_id) {
        const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE id = ?", res.lot_id);
        if (lot) {
          const next = Math.max(0, tons(lot.reserved_tons - res.tons));
          run(this.db, "UPDATE lots SET reserved_tons = ? WHERE id = ?", next, lot.id);
        }
      }
      run(this.db, "DELETE FROM reservations WHERE id = ?", res.id);
    }
    if (order.side === "buy") {
      const corp = this.requireCorp(order.corp_id);
      const release = order.qty_remaining * order.price * (1 + FEE);
      run(this.db, "UPDATE corporations SET reserved_credits = ? WHERE id = ?", Math.max(0, tons(corp.reserved_credits - release)), corp.id);
    }
  }

  // --- market ------------------------------------------------------------------

  placeOrder(corpId: string, input: { bodyId: string; commodity: string; side: string; quantity: number; price: number; standingId?: string }): { id: string; filled: number } {
    const bodyId = this.body(input.bodyId);
    const commodity = this.commodity(input.commodity);
    const side = input.side;
    if (side !== "buy" && side !== "sell") {
      throw new ApiError(400, "bad_side", 'side must be "buy" or "sell".');
    }
    const quantity = pos(input.quantity, "quantity");
    const price = pos(input.price, "price");
    const corp = this.requireCorp(corpId);
    if (side === "buy") {
      const space = this.freeStorage(corpId, bodyId);
      if (space + 1e-6 < quantity) {
        throw new ApiError(
          400,
          "insufficient_storage",
          `Buying ${quantity} t needs free storage at ${bodyId}, and you have ${tons(space)} t free. Rent a bay (POST /api/leases) or unload a ship before placing the buy.`,
          { freeTons: tons(space), quantity, bodyId },
        );
      }
      const reserve = quantity * price * (1 + FEE);
      const freeCredits = corp.credits - corp.reserved_credits;
      if (freeCredits + 1e-6 < reserve) {
        throw new ApiError(
          400,
          "insufficient_credits",
          `This buy reserves ${reserve.toFixed(2)} credits (${quantity} t at ${price} plus the ${(FEE * 100).toFixed(1)}% exchange fee). You have ${freeCredits.toFixed(2)} credits free of ${corp.credits.toFixed(2)} (${corp.reserved_credits.toFixed(2)} already reserved). Lower the price or quantity, or cancel other bids.`,
          { needed: reserve, freeCredits, credits: corp.credits },
        );
      }
      run(this.db, "UPDATE corporations SET reserved_credits = ? WHERE id = ?", tons(corp.reserved_credits + reserve), corp.id);
    } else {
      const have = this.available(corpId, bodyId, commodity);
      if (have + 1e-6 < quantity) {
        throw new ApiError(
          400,
          "insufficient_goods",
          `You have ${tons(have)} t of unreserved ${commodity} at ${bodyId}, not ${quantity} t. Produce it, buy it, or unload it from a ship at ${bodyId} first.`,
          { have: tons(have), quantity, commodity, bodyId },
        );
      }
    }
    const id = nid("ord");
    run(
      this.db,
      "INSERT INTO orders (id, body_id, corp_id, commodity, side, qty_remaining, price, status, standing_id, created_sim_time) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      id,
      bodyId,
      corpId,
      commodity,
      side,
      quantity,
      price,
      input.standingId ?? null,
      this.simTime,
    );
    if (side === "sell") this.reserveLots(corpId, bodyId, commodity, quantity, { orderId: id });
    const before = quantity;
    this.matchCommodity(bodyId, commodity);
    const after = get<Order>(this.db, "SELECT * FROM orders WHERE id = ?", id);
    const filled = tons(before - (after?.status === "open" ? after.qty_remaining : 0));
    return { id, filled };
  }

  cancelOrder(corpId: string, orderId: string): void {
    const order = get<Order>(this.db, "SELECT * FROM orders WHERE id = ?", orderId);
    if (!order || order.status !== "open") {
      throw new ApiError(404, "not_found", `No open order ${orderId}. List your open orders in GET /api/me/briefing under orders.`);
    }
    if (order.corp_id !== corpId) throw new ApiError(403, "not_owner", "You can only cancel your own orders.");
    this.releaseOrderReservations(order);
    run(this.db, "UPDATE orders SET status = 'cancelled', qty_remaining = 0 WHERE id = ?", order.id);
  }

  private matchAll(): void {
    const bodies = new Set<string>();
    for (const row of all<{ body_id: string }>(this.db, "SELECT DISTINCT body_id FROM orders WHERE status = 'open'")) bodies.add(row.body_id);
    for (const row of all<{ body_id: string }>(this.db, "SELECT DISTINCT body_id FROM space_bids WHERE status = 'open'")) bodies.add(row.body_id);
    for (const row of all<{ body_id: string }>(this.db, "SELECT DISTINCT body_id FROM warehouses WHERE listed_tons > 0")) bodies.add(row.body_id);
    for (const bodyId of bodies) {
      for (const commodity of COMMODITIES) this.matchCommodity(bodyId, commodity);
      this.matchSpace(bodyId);
    }
  }

  private matchCommodity(bodyId: string, commodity: string): void {
    for (let guard = 0; guard < 200; guard++) {
      const buy = get<Order>(
        this.db,
        "SELECT * FROM orders WHERE body_id = ? AND commodity = ? AND side = 'buy' AND status = 'open' AND qty_remaining > 1e-8 ORDER BY price DESC, created_sim_time ASC LIMIT 1",
        bodyId,
        commodity,
      );
      const sell = get<Order>(
        this.db,
        "SELECT * FROM orders WHERE body_id = ? AND commodity = ? AND side = 'sell' AND status = 'open' AND qty_remaining > 1e-8 ORDER BY price ASC, created_sim_time ASC LIMIT 1",
        bodyId,
        commodity,
      );
      if (!buy || !sell || buy.price + 1e-9 < sell.price) return;
      if (buy.corp_id === sell.corp_id) {
        this.forceCancel(sell, "Cancelled a self-crossing sell so the book cannot trade with itself.");
        continue;
      }
      const space = this.freeStorage(buy.corp_id, bodyId);
      if (space <= 1e-6) {
        this.forceCancel(buy, `Buy cancelled: no free storage left at ${bodyId} to receive ${commodity}.`);
        continue;
      }
      const price = buy.created_sim_time <= sell.created_sim_time ? buy.price : sell.price;
      let qty = Math.min(buy.qty_remaining, sell.qty_remaining, space);
      const reservations = all<{ id: string; lot_id: string; tons: number }>(
        this.db,
        "SELECT * FROM reservations WHERE order_id = ? AND tons > 1e-9 ORDER BY id",
        sell.id,
      );
      let moved = 0;
      let left = qty;
      for (const res of reservations) {
        if (left <= 1e-9) break;
        const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE id = ?", res.lot_id);
        if (!lot) {
          run(this.db, "DELETE FROM reservations WHERE id = ?", res.id);
          continue;
        }
        const part = tons(Math.min(left, res.tons, lot.tons, lot.reserved_tons));
        if (part <= 0) continue;
        const nextTons = tons(lot.tons - part);
        const nextRes = tons(lot.reserved_tons - part);
        if (nextTons <= 1e-9) run(this.db, "DELETE FROM lots WHERE id = ?", lot.id);
        else run(this.db, "UPDATE lots SET tons = ?, reserved_tons = ? WHERE id = ?", nextTons, Math.max(0, nextRes), lot.id);
        const resLeft = tons(res.tons - part);
        if (resLeft <= 1e-9) run(this.db, "DELETE FROM reservations WHERE id = ?", res.id);
        else run(this.db, "UPDATE reservations SET tons = ? WHERE id = ?", resLeft, res.id);
        moved += part;
        left -= part;
      }
      if (moved <= 1e-8) {
        this.forceCancel(sell, "Sell cancelled: the escrowed cargo was no longer in the container.");
        continue;
      }
      const stored = this.storeOutput(buy.corp_id, bodyId, commodity, moved);
      if (stored + 1e-6 < moved) {
        // Should not happen because space was checked. Put the difference back on the seller rather than deleting it.
        this.storeOutput(sell.corp_id, bodyId, commodity, moved - stored);
        moved = stored;
      }
      const cost = moved * price;
      const fee = cost * FEE;
      const buyer = this.requireCorp(buy.corp_id);
      const seller = this.requireCorp(sell.corp_id);
      const release = moved * buy.price * (1 + FEE);
      run(
        this.db,
        "UPDATE corporations SET credits = ?, reserved_credits = ? WHERE id = ?",
        tons(buyer.credits - cost - fee),
        Math.max(0, tons(buyer.reserved_credits - release)),
        buyer.id,
      );
      run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(seller.credits + cost), seller.id);
      this.shrinkOrder(buy, moved);
      this.shrinkOrder(sell, moved);
      const message = `${buyer.name} bought ${tons(moved)} t of ${commodity} from ${seller.name} at ${bodyId} for ${cost.toFixed(0)} cr.`;
      this.log("trade", message, { public: true, payload: { bodyId, commodity, tons: tons(moved), price, buyer: buyer.id, seller: seller.id } });
      this.log("trade", message, { corpId: buyer.id, public: false, payload: { bodyId, commodity, tons: tons(moved) } });
      this.log("trade", message, { corpId: seller.id, public: false, payload: { bodyId, commodity, tons: tons(moved) } });
      qty = moved;
    }
  }

  private shrinkOrder(order: Order, filled: number): void {
    const left = tons(order.qty_remaining - filled);
    if (left <= 1e-6) {
      if (order.side === "buy") {
        const leftover = left > 0 ? left : 0;
        const corp = this.requireCorp(order.corp_id);
        const release = Math.max(0, leftover) * order.price * (1 + FEE);
        if (release > 0) {
          run(this.db, "UPDATE corporations SET reserved_credits = ? WHERE id = ?", Math.max(0, this.requireCorp(order.corp_id).reserved_credits - release), corp.id);
        }
      }
      run(this.db, "UPDATE orders SET qty_remaining = 0, status = 'filled' WHERE id = ?", order.id);
      if (order.side === "sell") this.releaseOrderReservations({ ...order, qty_remaining: 0, side: "sell" });
    } else {
      run(this.db, "UPDATE orders SET qty_remaining = ? WHERE id = ?", left, order.id);
    }
  }

  private forceCancel(order: Order, message: string): void {
    const fresh = get<Order>(this.db, "SELECT * FROM orders WHERE id = ?", order.id);
    if (!fresh || fresh.status !== "open") return;
    this.releaseOrderReservations(fresh);
    run(this.db, "UPDATE orders SET status = 'cancelled', qty_remaining = 0 WHERE id = ?", fresh.id);
    this.log("order_cancelled", message, { corpId: fresh.corp_id, public: false });
  }

  placeStanding(corpId: string, input: { bodyId: string; commodity: string; side: string; targetTons: number; limitPrice: number; batchTons: number }): { id: string } {
    const bodyId = this.body(input.bodyId);
    const commodity = this.commodity(input.commodity);
    if (input.side !== "buy" && input.side !== "sell") throw new ApiError(400, "bad_side", 'side must be "buy" or "sell".');
    const target = pos(input.targetTons, "targetTons");
    const limit = pos(input.limitPrice, "limitPrice");
    const batch = pos(input.batchTons, "batchTons");
    const id = nid("std");
    run(
      this.db,
      "INSERT INTO standing_orders (id, corp_id, body_id, commodity, side, target_tons, limit_price, batch_tons, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      id,
      corpId,
      bodyId,
      commodity,
      input.side,
      target,
      limit,
      batch,
    );
    this.syncStanding();
    this.matchAll();
    return { id };
  }

  cancelStanding(corpId: string, id: string): void {
    const row = get<{ id: string; corp_id: string }>(this.db, "SELECT * FROM standing_orders WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No standing order ${id}.`);
    if (row.corp_id !== corpId) throw new ApiError(403, "not_owner", "You can only cancel your own standing orders.");
    run(this.db, "UPDATE standing_orders SET active = 0 WHERE id = ?", id);
    const open = all<Order>(this.db, "SELECT * FROM orders WHERE standing_id = ? AND status = 'open'", id);
    for (const order of open) this.forceCancel(order, "Cancelled because the standing order was removed.");
  }

  private syncStanding(): void {
    const rows = all<{
      id: string;
      corp_id: string;
      body_id: string;
      commodity: string;
      side: string;
      target_tons: number;
      limit_price: number;
      batch_tons: number;
    }>(this.db, "SELECT * FROM standing_orders WHERE active = 1");
    for (const row of rows) {
      const open = get<Order>(this.db, "SELECT * FROM orders WHERE standing_id = ? AND status = 'open'", row.id);
      if (open) continue;
      const have = this.available(row.corp_id, row.body_id, row.commodity);
      try {
        this.savepoint("standing", () => {
          if (row.side === "buy" && have < row.target_tons - 1e-6) {
            const qty = Math.min(row.batch_tons, row.target_tons - have);
            if (qty > 1e-6) this.placeOrder(row.corp_id, { bodyId: row.body_id, commodity: row.commodity, side: "buy", quantity: qty, price: row.limit_price, standingId: row.id });
          } else if (row.side === "sell" && have > row.target_tons + 1e-6) {
            const qty = Math.min(row.batch_tons, have - row.target_tons);
            if (qty > 1e-6) this.placeOrder(row.corp_id, { bodyId: row.body_id, commodity: row.commodity, side: "sell", quantity: qty, price: row.limit_price, standingId: row.id });
          }
        });
      } catch {
        /* unmet standing orders wait for storage, credits, or stock */
      }
    }
  }

  // --- warehouses --------------------------------------------------------------

  listWarehouse(corpId: string, warehouseId: string, tonsToList: number, rate: number): void {
    const wh = this.warehouse(warehouseId);
    if (wh.owner_corp_id !== corpId) throw new ApiError(403, "not_owner", "Only the warehouse owner can list spare capacity.");
    const qty = Number(tonsToList);
    if (!Number.isFinite(qty) || qty < 0) throw new ApiError(400, "bad_number", "tons must be 0 or more. Use 0 to delist.");
    if (qty === 0) {
      run(this.db, "UPDATE warehouses SET listed_tons = 0, listed_rate = NULL WHERE id = ?", wh.id);
      return;
    }
    const price = pos(rate, "rate");
    const leased = this.leasedTons(wh.id);
    const owner = this.ownerContainer(wh.id);
    const free = wh.capacity_tons - leased - this.storedTons(owner.id);
    if (qty > free + 1e-4) {
      throw new ApiError(
        400,
        "insufficient_space",
        `Only ${tons(Math.max(0, free))} t of ${wh.name} is free to list (${wh.capacity_tons} t total, ${tons(leased)} t leased, ${tons(this.storedTons(owner.id))} t of your own cargo). Lower tons or move cargo out.`,
        { free: tons(Math.max(0, free)) },
      );
    }
    run(this.db, "UPDATE warehouses SET listed_tons = ?, listed_rate = ? WHERE id = ?", qty, price, wh.id);
    this.matchSpace(wh.body_id);
  }

  placeSpaceBid(corpId: string, bodyIdRaw: string, tonsWanted: number, maxRate: number): { id: string } {
    const bodyId = this.body(bodyIdRaw);
    const qty = pos(tonsWanted, "tons");
    const rate = pos(maxRate, "maxRate");
    const id = nid("sbid");
    run(
      this.db,
      "INSERT INTO space_bids (id, corp_id, body_id, tons, max_rate, status, created_sim_time) VALUES (?, ?, ?, ?, ?, 'open', ?)",
      id,
      corpId,
      bodyId,
      qty,
      rate,
      this.simTime,
    );
    this.matchSpace(bodyId);
    return { id };
  }

  takeLease(corpId: string, warehouseId: string, amount: number): { leaseId: string } {
    const wh = this.warehouse(warehouseId);
    const qty = pos(amount, "tons");
    if (wh.listed_rate == null || wh.listed_tons <= 0) {
      throw new ApiError(400, "not_listed", `${wh.name} at ${wh.body_id} is not listing space. Check GET /api/markets/${wh.body_id} space.asks.`);
    }
    if (qty > wh.listed_tons + 1e-6) {
      throw new ApiError(
        400,
        "insufficient_space",
        `${wh.name} lists ${tons(wh.listed_tons)} t at ${wh.listed_rate} cr per ton per game-day. Ask for that much or less.`,
        { listed: wh.listed_tons, rate: wh.listed_rate },
      );
    }
    const leaseId = this.createLease(corpId, wh, qty, wh.listed_rate);
    return { leaseId };
  }

  private createLease(tenantId: string, wh: Warehouse, amount: number, rate: number): string {
    if (wh.owner_corp_id === tenantId) {
      throw new ApiError(400, "own_warehouse", "You own that warehouse, so you already control its free space. List it if you want someone else to rent it.");
    }
    const leased = this.leasedTons(wh.id);
    const owner = this.ownerContainer(wh.id);
    const free = wh.capacity_tons - leased - this.storedTons(owner.id);
    if (amount > free + 1e-4) {
      throw new ApiError(400, "insufficient_space", `Only ${tons(Math.max(0, free))} t can be leased in ${wh.name} right now.`);
    }
    const id = nid("lease");
    run(
      this.db,
      "INSERT INTO leases (id, warehouse_id, tenant_corp_id, tons, rate_per_ton_day, accrued_unpaid, unpaid_since, status, created_sim_time) VALUES (?, ?, ?, ?, ?, 0, NULL, 'active', ?)",
      id,
      wh.id,
      tenantId,
      amount,
      rate,
      this.simTime,
    );
    run(
      this.db,
      "INSERT INTO containers (id, kind, body_id, owner_corp_id, capacity_tons, warehouse_id, lease_id, ship_id) VALUES (?, 'bay', ?, ?, ?, ?, ?, NULL)",
      nid("box"),
      wh.body_id,
      tenantId,
      amount,
      wh.id,
      id,
    );
    run(this.db, "UPDATE warehouses SET listed_tons = ? WHERE id = ?", tons(Math.max(0, wh.listed_tons - amount)), wh.id);
    run(this.db, "UPDATE containers SET capacity_tons = ? WHERE id = ?", tons(wh.capacity_tons - leased - amount), owner.id);
    const tenant = this.requireCorp(tenantId);
    const ownerCorp = this.requireCorp(wh.owner_corp_id);
    this.log("lease", `${tenant.name} leased ${tons(amount)} t in ${wh.name} at ${wh.body_id} for ${rate} cr/t/day.`, {
      public: true,
      payload: { leaseId: id, bodyId: wh.body_id },
    });
    this.log("lease", `Leased ${tons(amount)} t from ${ownerCorp.name} at ${wh.body_id}. Rent is collected automatically. After ${GRACE_S / 86400} unpaid game-days the landlord may seize cargo.`, {
      corpId: tenantId,
      public: false,
    });
    return id;
  }

  private matchSpace(bodyId: string): void {
    for (let guard = 0; guard < 50; guard++) {
      const bid = get<{ id: string; corp_id: string; tons: number; max_rate: number }>(
        this.db,
        "SELECT * FROM space_bids WHERE body_id = ? AND status = 'open' AND tons > 1e-6 ORDER BY max_rate DESC, created_sim_time ASC LIMIT 1",
        bodyId,
      );
      if (!bid) return;
      const wh = get<Warehouse>(
        this.db,
        "SELECT * FROM warehouses WHERE body_id = ? AND listed_tons > 1e-6 AND listed_rate IS NOT NULL AND listed_rate <= ? AND owner_corp_id != ? ORDER BY listed_rate ASC LIMIT 1",
        bodyId,
        bid.max_rate,
        bid.corp_id,
      );
      if (!wh || wh.listed_rate == null) return;
      const qty = Math.min(bid.tons, wh.listed_tons);
      try {
        this.savepoint("space", () => this.createLease(bid.corp_id, wh, qty, wh.listed_rate!));
      } catch {
        return;
      }
      const left = tons(bid.tons - qty);
      if (left <= 1e-6) run(this.db, "UPDATE space_bids SET tons = 0, status = 'filled' WHERE id = ?", bid.id);
      else run(this.db, "UPDATE space_bids SET tons = ? WHERE id = ?", left, bid.id);
    }
  }

  seizeLease(corpId: string, leaseId: string): { seizedTons: number } {
    const lease = this.lease(leaseId);
    const wh = this.warehouse(lease.warehouse_id);
    if (wh.owner_corp_id !== corpId) throw new ApiError(403, "not_owner", "Only the landlord can seize a lease.");
    if (lease.status !== "active") throw new ApiError(400, "bad_lease", `Lease ${leaseId} is ${lease.status}, not active.`);
    if (!this.leaseSeizable(lease)) {
      const wait = lease.unpaid_since == null ? GRACE_S : Math.max(0, GRACE_S - (this.simTime - lease.unpaid_since));
      throw new ApiError(
        400,
        "not_seizable",
        `Unpaid balance is ${lease.accrued_unpaid.toFixed(2)} cr. Seizure opens after ${GRACE_S / 86400} game-days unpaid. About ${(wait / 86400).toFixed(2)} game-days of grace remain. Rent is collected automatically when the tenant has free credits.`,
        { accrued: lease.accrued_unpaid, graceDays: GRACE_S / 86400 },
      );
    }
    const bay = get<Container>(this.db, "SELECT * FROM containers WHERE lease_id = ?", lease.id);
    let seized = 0;
    if (bay) {
      const owner = this.ownerContainer(wh.id);
      for (const lot of all<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ?", bay.id)) {
        const freeLots = tons(lot.tons - lot.reserved_tons);
        if (freeLots > 0) {
          this.addCommodity(owner.id, lot.commodity, freeLots);
          seized += freeLots;
        }
        run(this.db, "DELETE FROM lots WHERE id = ?", lot.id);
      }
      run(this.db, "UPDATE containers SET capacity_tons = 0 WHERE id = ?", bay.id);
    }
    const leasedOthers = this.leasedTons(wh.id) - lease.tons;
    const ownerBox = this.ownerContainer(wh.id);
    run(this.db, "UPDATE containers SET capacity_tons = ? WHERE id = ?", tons(wh.capacity_tons - Math.max(0, leasedOthers)), ownerBox.id);
    run(this.db, "UPDATE leases SET status = 'seized', accrued_unpaid = 0 WHERE id = ?", lease.id);
    this.log("seizure", `Landlord seized ${tons(seized)} t from lease ${lease.id} at ${wh.body_id}.`, {
      public: true,
      corpId: lease.tenant_corp_id,
      payload: { leaseId, tons: tons(seized) },
    });
    return { seizedTons: tons(seized) };
  }

  endLease(corpId: string, leaseId: string): void {
    const lease = this.lease(leaseId);
    if (lease.tenant_corp_id !== corpId) throw new ApiError(403, "not_owner", "Only the tenant can end a lease early.");
    if (lease.status !== "active") throw new ApiError(400, "bad_lease", `Lease ${leaseId} is already ${lease.status}.`);
    if (lease.accrued_unpaid > 1e-4) {
      throw new ApiError(
        400,
        "rent_unpaid",
        `This lease still owes ${lease.accrued_unpaid.toFixed(2)} cr. Credits are applied to rent automatically on the sim tick once they are not reserved by bids. Clear the balance before ending the lease, or the landlord can seize after the grace period.`,
      );
    }
    const bay = get<Container>(this.db, "SELECT * FROM containers WHERE lease_id = ?", lease.id);
    if (bay && this.storedTons(bay.id) > 1e-6) {
      throw new ApiError(
        400,
        "bay_not_empty",
        `The bay still holds ${tons(this.storedTons(bay.id))} t. Sell it, move it into a ship with POST /api/ships/:id/load, or otherwise empty the bay before ending the lease.`,
      );
    }
    const wh = this.warehouse(lease.warehouse_id);
    if (bay) run(this.db, "DELETE FROM containers WHERE id = ?", bay.id);
    run(this.db, "UPDATE leases SET status = 'ended' WHERE id = ?", lease.id);
    const owner = this.ownerContainer(wh.id);
    run(this.db, "UPDATE containers SET capacity_tons = ? WHERE id = ?", tons(wh.capacity_tons - this.leasedTons(wh.id)), owner.id);
  }

  private leaseSeizable(lease: Lease): boolean {
    return lease.accrued_unpaid > 1e-4 && lease.unpaid_since != null && this.simTime - lease.unpaid_since >= GRACE_S;
  }

  private leasedTons(warehouseId: string): number {
    const row = get<{ s: number }>(this.db, "SELECT COALESCE(SUM(tons), 0) AS s FROM leases WHERE warehouse_id = ? AND status = 'active'", warehouseId);
    return row?.s ?? 0;
  }

  private ownerContainer(warehouseId: string): Container {
    const row = get<Container>(this.db, "SELECT * FROM containers WHERE warehouse_id = ? AND kind = 'warehouse_owner'", warehouseId);
    if (!row) throw new ApiError(500, "corrupt", `Warehouse ${warehouseId} has no owner container.`);
    return row;
  }

  // --- assets and construction -------------------------------------------------

  listAsset(corpId: string, assetType: string, assetId: string, price: number | null): void {
    if (assetType === "ship") {
      const ship = this.ship(assetId);
      if (ship.owner_corp_id !== corpId) throw new ApiError(403, "not_owner", "You do not own that ship.");
      if (ship.state !== "orbiting" || ship.flight_json) {
        throw new ApiError(400, "ship_busy", "Only an orbiting ship with no filed flight plan can be listed. Wait until it arrives, or cancel the launch.");
      }
      run(this.db, "UPDATE ships SET ask_price = ? WHERE id = ?", price, ship.id);
      return;
    }
    if (assetType === "facility") {
      const fac = this.facility(assetId);
      if (fac.owner_corp_id !== corpId) throw new ApiError(403, "not_owner", "You do not own that facility.");
      run(this.db, "UPDATE facilities SET ask_price = ? WHERE id = ?", price, fac.id);
      return;
    }
    if (assetType === "warehouse") {
      const wh = this.warehouse(assetId);
      if (wh.owner_corp_id !== corpId) throw new ApiError(403, "not_owner", "You do not own that warehouse.");
      const owner = this.ownerContainer(wh.id);
      if (price != null && this.storedTons(owner.id) > 1e-6) {
        throw new ApiError(400, "warehouse_not_empty", `Move your ${tons(this.storedTons(owner.id))} t out of ${wh.name} before listing it. Leased bays can stay; your own cargo conveys and is blocked on purpose.`);
      }
      run(this.db, "UPDATE warehouses SET ask_price = ? WHERE id = ?", price, wh.id);
      return;
    }
    throw new ApiError(400, "bad_asset", 'assetType must be "ship", "facility", or "warehouse".');
  }

  buyAsset(corpId: string, assetType: string, assetId: string): { price: number; fee: number } {
    const buyer = this.requireCorp(corpId);
    let sellerId = "";
    let price = 0;
    let label = assetId;
    if (assetType === "ship") {
      const ship = this.ship(assetId);
      if (ship.ask_price == null) throw new ApiError(400, "not_for_sale", `Ship ${ship.name} is not listed. Read assets on GET /api/markets/${ship.body_id}.`);
      if (ship.state !== "orbiting" || ship.flight_json) throw new ApiError(400, "ship_busy", "That ship left or has a filed plan. Listings close when a ship launches.");
      sellerId = ship.owner_corp_id;
      price = ship.ask_price;
      label = ship.name;
    } else if (assetType === "facility") {
      const fac = this.facility(assetId);
      if (fac.ask_price == null) throw new ApiError(400, "not_for_sale", `Facility ${fac.name} is not listed.`);
      sellerId = fac.owner_corp_id;
      price = fac.ask_price;
      label = fac.name;
    } else if (assetType === "warehouse") {
      const wh = this.warehouse(assetId);
      if (wh.ask_price == null) throw new ApiError(400, "not_for_sale", `Warehouse ${wh.name} is not listed.`);
      sellerId = wh.owner_corp_id;
      price = wh.ask_price;
      label = wh.name;
    } else {
      throw new ApiError(400, "bad_asset", 'assetType must be "ship", "facility", or "warehouse".');
    }
    if (sellerId === corpId) throw new ApiError(400, "own_asset", "You already own that. Cancel the listing with price null if you do not want to sell.");
    const fee = price * FEE;
    const freeCredits = buyer.credits - buyer.reserved_credits;
    if (freeCredits + 1e-6 < price + fee) {
      throw new ApiError(
        400,
        "insufficient_credits",
        `${label} costs ${price} cr plus ${fee.toFixed(2)} cr exchange fee. You have ${freeCredits.toFixed(2)} cr free.`,
        { price, fee, freeCredits },
      );
    }
    const seller = this.requireCorp(sellerId);
    run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(buyer.credits - price - fee), buyer.id);
    run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(seller.credits + price), seller.id);
    if (assetType === "ship") {
      run(this.db, "UPDATE ships SET owner_corp_id = ?, ask_price = NULL WHERE id = ?", corpId, assetId);
      run(this.db, "UPDATE containers SET owner_corp_id = ? WHERE ship_id = ?", corpId, assetId);
    } else if (assetType === "facility") {
      run(this.db, "UPDATE facilities SET owner_corp_id = ?, ask_price = NULL WHERE id = ?", corpId, assetId);
    } else {
      run(this.db, "UPDATE warehouses SET owner_corp_id = ?, ask_price = NULL WHERE id = ?", corpId, assetId);
      run(this.db, "UPDATE containers SET owner_corp_id = ? WHERE warehouse_id = ? AND kind = 'warehouse_owner'", corpId, assetId);
    }
    this.log("asset_sale", `${buyer.name} bought ${label} from ${seller.name} for ${price} cr.`, { public: true, payload: { assetType, assetId, price } });
    return { price, fee };
  }

  construct(corpId: string, bodyIdRaw: string, recipeId: string): { id: string; completesAt: number } {
    const bodyId = this.body(bodyIdRaw);
    const recipe = BUILD[recipeId];
    if (!recipe) {
      throw new ApiError(400, "bad_recipe", `Unknown recipe "${recipeId}". Recipes: ${Object.keys(BUILD).join(", ")}.`);
    }
    if (recipe.requiresDeposit && depositOf(bodyId, recipe.requiresDeposit) <= 0) {
      const present = Object.entries(DEPOSITS[bodyId] ?? {})
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([k]) => k);
      throw new ApiError(
        400,
        "no_deposit",
        `${bodyId} has no ${recipe.requiresDeposit} deposit, so ${recipeId} cannot be built there. Deposits here: ${present.join(", ") || "none"}.`,
      );
    }
    let payee: string | null = null;
    if (recipe.requiresShipyard) {
      const yard = get<Facility>(this.db, "SELECT * FROM facilities WHERE body_id = ? AND kind = 'shipyard' AND active = 1 LIMIT 1", bodyId);
      if (!yard) {
        throw new ApiError(400, "no_shipyard", `Ships are built at a shipyard. ${bodyId} has none. Build a shipyard there, or construct at Earth, Luna, or Mars where the legacy yards are.`);
      }
      payee = yard.owner_corp_id;
    }
    for (const [commodity, need] of Object.entries(recipe.materials)) {
      const have = this.available(corpId, bodyId, commodity);
      if (have + 1e-6 < (need ?? 0)) {
        throw new ApiError(
          400,
          "insufficient_goods",
          `${recipeId} needs ${need} t of ${commodity} at ${bodyId}. You have ${tons(have)} t unreserved. Stock the materials in a warehouse, bay, or orbiting ship at ${bodyId}.`,
          { commodity, need, have: tons(have), bodyId },
        );
      }
    }
    const corp = this.requireCorp(corpId);
    const freeCredits = corp.credits - corp.reserved_credits;
    const creditsLeave = payee === corpId ? 0 : recipe.credits;
    if (freeCredits + 1e-6 < creditsLeave) {
      throw new ApiError(400, "insufficient_credits", `${recipeId} costs ${recipe.credits} cr. You have ${freeCredits.toFixed(2)} cr free.`);
    }
    for (const [commodity, need] of Object.entries(recipe.materials)) {
      const got = this.draw(corpId, bodyId, commodity, need ?? 0);
      if (got + 1e-6 < (need ?? 0)) throw new ApiError(400, "insufficient_goods", `Could only draw ${got} t of ${commodity}.`);
    }
    if (creditsLeave > 0) {
      run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(corp.credits - creditsLeave), corp.id);
      if (payee) {
        const owner = this.requireCorp(payee);
        run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(owner.credits + creditsLeave), owner.id);
      }
    }
    const id = nid("job");
    const completesAt = this.simTime + recipe.days * 86400;
    run(
      this.db,
      "INSERT INTO constructions (id, corp_id, body_id, recipe, completes_at, status, created_sim_time) VALUES (?, ?, ?, ?, ?, 'building', ?)",
      id,
      corpId,
      bodyId,
      recipeId,
      completesAt,
      this.simTime,
    );
    this.log("construction", `${corp.name} started ${recipeId} at ${bodyId}.`, { corpId, public: true, payload: { id, completesAt } });
    return { id, completesAt };
  }

  // --- ships -------------------------------------------------------------------

  loadShip(corpId: string, shipId: string, commodityRaw: string, amount: number): { loaded: number } {
    const ship = this.ownShip(corpId, shipId);
    this.assertDocked(ship);
    const commodity = this.commodity(commodityRaw);
    const qty = pos(amount, "tons");
    if (commodity === "propellant") {
      const room = ship.tank_capacity - ship.tank_tons;
      if (room <= 1e-6) throw new ApiError(400, "tank_full", `The tank is full at ${ship.tank_capacity} t.`);
      const got = this.draw(corpId, ship.body_id, commodity, Math.min(qty, room), ship.id);
      if (got <= 1e-8) {
        const have = this.available(corpId, ship.body_id, commodity);
        throw new ApiError(
          400,
          "insufficient_goods",
          `No unreserved propellant at ${ship.body_id} outside this ship (found ${tons(have)} t). Buy propellant on the local market into a bay or warehouse, then load it.`,
          { have: tons(have), bodyId: ship.body_id },
        );
      }
      run(this.db, "UPDATE ships SET tank_tons = ? WHERE id = ?", tons(ship.tank_tons + got), ship.id);
      return { loaded: got };
    }
    const hold = this.hold(ship.id);
    const room = hold.capacity_tons - this.storedTons(hold.id);
    if (room <= 1e-6) throw new ApiError(400, "hold_full", `The cargo hold is full (${hold.capacity_tons} t).`);
    const got = this.draw(corpId, ship.body_id, commodity, Math.min(qty, room), ship.id);
    if (got <= 1e-8) {
      throw new ApiError(400, "insufficient_goods", `No unreserved ${commodity} at ${ship.body_id} to load. Your inventory is in GET /api/me/briefing.`);
    }
    this.addCommodity(hold.id, commodity, got);
    return { loaded: got };
  }

  unloadShip(corpId: string, shipId: string, commodityRaw: string, amount: number): { unloaded: number } {
    const ship = this.ownShip(corpId, shipId);
    this.assertDocked(ship);
    const commodity = this.commodity(commodityRaw);
    const qty = pos(amount, "tons");
    const otherFree = this.groundContainers(corpId, ship.body_id)
      .filter((c) => c.ship_id !== ship.id)
      .reduce((s, c) => s + this.freeIn(c), 0);
    if (otherFree <= 1e-6) {
      throw new ApiError(
        400,
        "insufficient_storage",
        `Nowhere at ${ship.body_id} to put cargo except this ship. Rent a warehouse bay or own a warehouse there first.`,
      );
    }
    const move = Math.min(qty, otherFree);
    if (commodity === "propellant") {
      const got = Math.min(move, ship.tank_tons);
      if (got <= 1e-8) throw new ApiError(400, "empty_tank", "The tank is already empty.");
      const stored = this.storeOutsideHold(corpId, ship, commodity, got);
      if (stored + 1e-6 < got) throw new ApiError(400, "insufficient_storage", `Only ${tons(stored)} t of storage was free outside the ship.`);
      run(this.db, "UPDATE ships SET tank_tons = ? WHERE id = ?", tons(ship.tank_tons - stored), ship.id);
      return { unloaded: stored };
    }
    const hold = this.hold(ship.id);
    const got = this.takeAvailable(hold.id, commodity, move);
    if (got <= 1e-8) throw new ApiError(400, "insufficient_goods", `The hold does not contain unreserved ${commodity}.`);
    const stored = this.storeOutsideHold(corpId, ship, commodity, got);
    if (stored + 1e-6 < got) {
      this.addCommodity(hold.id, commodity, got - stored);
      throw new ApiError(400, "insufficient_storage", `Only ${tons(stored)} t of storage was free outside the ship.`);
    }
    return { unloaded: got };
  }

  private storeOutsideHold(corpId: string, ship: Ship, commodity: string, amount: number): number {
    let left = amount;
    for (const c of this.groundContainers(corpId, ship.body_id)) {
      if (c.ship_id === ship.id) continue;
      const room = this.freeIn(c);
      const put = Math.min(room, left);
      if (put > 0) {
        this.addCommodity(c.id, commodity, put);
        left -= put;
      }
    }
    return tons(amount - left);
  }

  launch(corpId: string, shipId: string, toBodyIdRaw: string, preference?: string): FlightPlan {
    const ship = this.ownShip(corpId, shipId);
    this.assertDocked(ship);
    const toBodyId = this.body(toBodyIdRaw);
    if (toBodyId === ship.body_id) {
      throw new ApiError(400, "same_body", `The ship is already at ${toBodyId}. Pick a different destination.`);
    }
    if (toBodyId === "sun") throw new ApiError(400, "bad_destination", "Ships cannot orbit the Sun. Pick a planet, moon, or minor body.");
    const pref = preference === "faster" ? "faster" : "min_delta_v";
    let options: RouteOption[];
    try {
      options = planRoutes(ship.body_id, toBodyId, this.simTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Route solver failed.";
      throw new ApiError(400, "no_route", message);
    }
    const option = options.find((o) => o.kind === pref) ?? options[0]!;
    const cargo = this.holdMass(ship.id);
    const dry = ship.dry_mass_tons + cargo;
    const fuel = propellantForDeltaV(dry, option.deltaV, ship.isp_s);
    if (ship.tank_tons + 1e-6 < fuel.propellantTons) {
      throw new ApiError(
        400,
        "insufficient_propellant",
        `The ${option.kind} route from ${ship.body_id} to ${toBodyId} needs ${fuel.propellantTons.toFixed(2)} t of tank propellant for ${option.deltaV.toFixed(2)} km/s (dry mass ${ship.dry_mass_tons} t + cargo ${cargo.toFixed(2)} t, Isp ${ship.isp_s} s). The tank has ${ship.tank_tons.toFixed(2)} t of ${ship.tank_capacity} t. Load propellant or unload cargo, or POST again with preference "faster" or "min_delta_v".`,
        {
          needed: tons(fuel.propellantTons),
          tank: tons(ship.tank_tons),
          tankCapacity: ship.tank_capacity,
          deltaV: option.deltaV,
          cargo: tons(cargo),
          options: options.map((o) => ({ kind: o.kind, deltaV: o.deltaV, departAt: o.departAt, arriveAt: o.arriveAt })),
        },
      );
    }
    run(this.db, "UPDATE ships SET tank_tons = ?, ask_price = NULL WHERE id = ?", tons(ship.tank_tons - fuel.propellantTons), ship.id);
    const plan: FlightPlan = {
      toBodyId,
      fromBodyId: ship.body_id,
      departAt: option.departAt,
      arriveAt: option.arriveAt,
      deltaV: option.deltaV,
      deltaVDepart: option.deltaVDepart,
      deltaVArrive: option.deltaVArrive,
      burnedTons: tons(fuel.propellantTons),
      frameId: option.frameId,
      mu: option.mu,
      r0: option.r0,
      v0: option.v0,
      preference: option.kind,
      propellantPerTonneDry: option.propellantPerTonneDry,
    };
    const state = this.simTime + 1 >= plan.departAt ? "in_transit" : "orbiting";
    run(this.db, "UPDATE ships SET flight_json = ?, state = ? WHERE id = ?", JSON.stringify(plan), state, ship.id);
    const when = state === "in_transit" ? "departed" : `will depart at ${simTimeToIso(plan.departAt)}`;
    this.log("launch", `${ship.name} ${when} for ${toBodyId} (${option.deltaV.toFixed(2)} km/s, arrives ${simTimeToIso(plan.arriveAt)}).`, {
      public: true,
      corpId,
      payload: { shipId, toBodyId, arriveAt: plan.arriveAt },
    });
    return plan;
  }

  cancelLaunch(corpId: string, shipId: string): void {
    const ship = this.ownShip(corpId, shipId);
    if (!ship.flight_json) throw new ApiError(400, "no_plan", "That ship has no filed flight plan.");
    if (ship.state === "in_transit") {
      throw new ApiError(400, "already_departed", "The ship has already burned and is coasting. Transfers are set-and-forget once in transit; wait for arrival.");
    }
    const plan = JSON.parse(ship.flight_json) as FlightPlan;
    const refund = Math.min(plan.burnedTons, ship.tank_capacity - ship.tank_tons);
    run(this.db, "UPDATE ships SET flight_json = NULL, tank_tons = ?, state = 'orbiting' WHERE id = ?", tons(ship.tank_tons + refund), ship.id);
    this.log("launch_cancelled", `${ship.name}'s departure was cancelled and ${tons(refund)} t of propellant returned to the tank.`, { corpId, public: false });
  }

  // --- deals -------------------------------------------------------------------

  sendMessage(corpId: string, toCorpId: string, content: string, bodyId?: string): { id: string } {
    const text = str(content, "text");
    if (text.length > 2000) throw new ApiError(400, "too_long", "Messages are limited to 2000 characters.");
    const to = this.requireCorp(toCorpId);
    if (to.id === corpId) throw new ApiError(400, "bad_recipient", "Send messages to a different corporation. ids are on the leaderboard.");
    const id = nid("msg");
    const body = bodyId ? this.body(bodyId) : null;
    run(
      this.db,
      "INSERT INTO messages (id, from_corp_id, to_corp_id, body_id, content, sim_time, read_flag) VALUES (?, ?, ?, ?, ?, ?, 0)",
      id,
      corpId,
      to.id,
      body,
      text,
      this.simTime,
    );
    this.log("message", `Message from ${this.requireCorp(corpId).name}.`, { corpId: to.id, public: false, payload: { id } });
    return { id };
  }

  createOffer(corpId: string, input: {
    toCorpId: string;
    bodyId: string;
    creditsOffered?: number;
    creditsRequested?: number;
    goodsOffered?: GoodLine[];
    goodsRequested?: GoodLine[];
    note?: string;
  }): { id: string } {
    const to = this.requireCorp(str(input.toCorpId, "toCorpId"));
    if (to.id === corpId) throw new ApiError(400, "bad_recipient", "Offers must be addressed to another corporation.");
    const bodyId = this.body(input.bodyId);
    const creditsOffered = input.creditsOffered ? pos(input.creditsOffered, "creditsOffered") : 0;
    const creditsRequested = input.creditsRequested ? pos(input.creditsRequested, "creditsRequested") : 0;
    const goodsOffered = this.goods(input.goodsOffered ?? []);
    const goodsRequested = this.goods(input.goodsRequested ?? []);
    if (creditsOffered === 0 && creditsRequested === 0 && goodsOffered.length === 0 && goodsRequested.length === 0) {
      throw new ApiError(400, "empty_offer", "An offer needs credits, goods, or both. Example: goodsOffered [{commodity:'propellant', tons:5}], creditsRequested: 2000.");
    }
    const corp = this.requireCorp(corpId);
    if (corp.credits - corp.reserved_credits + 1e-6 < creditsOffered) {
      throw new ApiError(400, "insufficient_credits", `Offering ${creditsOffered} cr but only ${(corp.credits - corp.reserved_credits).toFixed(2)} cr is free.`);
    }
    for (const line of goodsOffered) {
      const have = this.available(corpId, bodyId, line.commodity);
      if (have + 1e-6 < line.tons) {
        throw new ApiError(400, "insufficient_goods", `You cannot offer ${line.tons} t of ${line.commodity} at ${bodyId}; ${tons(have)} t is unreserved there.`);
      }
    }
    const incoming = goodsRequested.reduce((s, g) => s + g.tons, 0);
    const outgoing = goodsOffered.reduce((s, g) => s + g.tons, 0);
    const free = this.freeStorage(corpId, bodyId);
    if (free + outgoing + 1e-6 < incoming) {
      throw new ApiError(400, "insufficient_storage", `The goods you would receive (${incoming} t) do not fit in your free storage at ${bodyId} (${tons(free)} t) even after your offered cargo leaves.`);
    }
    const id = nid("offer");
    if (creditsOffered > 0) run(this.db, "UPDATE corporations SET reserved_credits = ? WHERE id = ?", tons(corp.reserved_credits + creditsOffered), corp.id);
    for (const line of goodsOffered) this.reserveLots(corpId, bodyId, line.commodity, line.tons, { offerId: id });
    run(
      this.db,
      "INSERT INTO offers (id, from_corp_id, to_corp_id, body_id, credits_offered, credits_requested, goods_offered_json, goods_requested_json, note, status, created_sim_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      id,
      corpId,
      to.id,
      bodyId,
      creditsOffered,
      creditsRequested,
      JSON.stringify(goodsOffered),
      JSON.stringify(goodsRequested),
      input.note ?? null,
      this.simTime,
    );
    this.log("offer", `${corp.name} sent you an offer at ${bodyId}.`, { corpId: to.id, public: false, payload: { id } });
    return { id };
  }

  acceptOffer(corpId: string, offerId: string): void {
    const offer = this.offer(offerId);
    if (offer.to_corp_id !== corpId) throw new ApiError(403, "not_recipient", "Only the corporation named in the offer can accept it.");
    if (offer.status !== "open") throw new ApiError(400, "bad_offer", `Offer ${offerId} is ${offer.status}, not open.`);
    const offered = JSON.parse(offer.goods_offered_json) as GoodLine[];
    const requested = JSON.parse(offer.goods_requested_json) as GoodLine[];
    const accepter = this.requireCorp(corpId);
    if (accepter.credits - accepter.reserved_credits + 1e-6 < offer.credits_requested) {
      throw new ApiError(400, "insufficient_credits", `Accepting requires ${offer.credits_requested} cr free. You have ${(accepter.credits - accepter.reserved_credits).toFixed(2)}.`);
    }
    for (const line of requested) {
      const have = this.available(corpId, offer.body_id, line.commodity);
      if (have + 1e-6 < line.tons) {
        throw new ApiError(400, "insufficient_goods", `The offer asks for ${line.tons} t of ${line.commodity} at ${offer.body_id}. You have ${tons(have)} t unreserved there.`);
      }
    }
    const incoming = offered.reduce((s, g) => s + g.tons, 0);
    const outgoing = requested.reduce((s, g) => s + g.tons, 0);
    const free = this.freeStorage(corpId, offer.body_id);
    if (free + outgoing + 1e-6 < incoming) {
      throw new ApiError(400, "insufficient_storage", `You need room for ${incoming} t at ${offer.body_id}. Free storage is ${tons(free)} t. Rent a larger bay before accepting.`);
    }
    const buffer = new Map<string, number>();
    const reservations = all<{ id: string; lot_id: string; tons: number; commodity: string }>(this.db, "SELECT * FROM reservations WHERE offer_id = ?", offer.id);
    for (const res of reservations) {
      const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE id = ?", res.lot_id);
      if (!lot) continue;
      const part = tons(Math.min(res.tons, lot.tons));
      const left = tons(lot.tons - part);
      const reserved = Math.max(0, tons(lot.reserved_tons - res.tons));
      if (left <= 1e-9) run(this.db, "DELETE FROM lots WHERE id = ?", lot.id);
      else run(this.db, "UPDATE lots SET tons = ?, reserved_tons = ? WHERE id = ?", left, reserved, lot.id);
      buffer.set(res.commodity, tons((buffer.get(res.commodity) ?? 0) + part));
      run(this.db, "DELETE FROM reservations WHERE id = ?", res.id);
    }
    for (const line of requested) {
      const got = this.draw(corpId, offer.body_id, line.commodity, line.tons);
      if (got + 1e-4 < line.tons) throw new ApiError(400, "insufficient_goods", `Could not draw ${line.commodity} to settle the offer.`);
      const stored = this.storeOutput(offer.from_corp_id, offer.body_id, line.commodity, got);
      if (stored + 1e-4 < got) throw new ApiError(400, "insufficient_storage", `The offerer no longer has room at ${offer.body_id} for ${line.commodity}.`);
    }
    for (const [commodity, qty] of buffer) {
      const stored = this.storeOutput(corpId, offer.body_id, commodity, qty);
      if (stored + 1e-4 < qty) throw new ApiError(400, "insufficient_storage", `Not enough room to receive ${commodity}.`);
    }
    const from = this.requireCorp(offer.from_corp_id);
    run(
      this.db,
      "UPDATE corporations SET credits = ?, reserved_credits = ? WHERE id = ?",
      tons(from.credits - offer.credits_offered + offer.credits_requested),
      Math.max(0, tons(from.reserved_credits - offer.credits_offered)),
      from.id,
    );
    const accepterFresh = this.requireCorp(corpId);
    run(
      this.db,
      "UPDATE corporations SET credits = ? WHERE id = ?",
      tons(accepterFresh.credits + offer.credits_offered - offer.credits_requested),
      corpId,
    );
    run(this.db, "UPDATE offers SET status = 'accepted' WHERE id = ?", offer.id);
    this.log("deal", `Offer ${offer.id} settled at ${offer.body_id}.`, { public: true, payload: { offerId: offer.id, bodyId: offer.body_id } });
    this.log("deal", `Your offer to ${accepter.name} was accepted.`, { corpId: from.id, public: false });
  }

  rejectOffer(corpId: string, offerId: string): void {
    const offer = this.offer(offerId);
    if (offer.to_corp_id !== corpId) throw new ApiError(403, "not_recipient", "Only the recipient can reject this offer.");
    if (offer.status !== "open") throw new ApiError(400, "bad_offer", `Offer is ${offer.status}.`);
    this.releaseOffer(offer, "rejected");
  }

  cancelOffer(corpId: string, offerId: string): void {
    const offer = this.offer(offerId);
    if (offer.from_corp_id !== corpId) throw new ApiError(403, "not_owner", "Only the sender can cancel this offer.");
    if (offer.status !== "open") throw new ApiError(400, "bad_offer", `Offer is ${offer.status}.`);
    this.releaseOffer(offer, "cancelled");
  }

  private releaseOffer(offer: { id: string; from_corp_id: string; credits_offered: number }, status: string): void {
    const reservations = all<{ id: string; lot_id: string; tons: number }>(this.db, "SELECT * FROM reservations WHERE offer_id = ?", offer.id);
    for (const res of reservations) {
      const lot = get<Lot>(this.db, "SELECT * FROM lots WHERE id = ?", res.lot_id);
      if (lot) run(this.db, "UPDATE lots SET reserved_tons = ? WHERE id = ?", Math.max(0, tons(lot.reserved_tons - res.tons)), lot.id);
      run(this.db, "DELETE FROM reservations WHERE id = ?", res.id);
    }
    const from = this.requireCorp(offer.from_corp_id);
    run(this.db, "UPDATE corporations SET reserved_credits = ? WHERE id = ?", Math.max(0, tons(from.reserved_credits - offer.credits_offered)), from.id);
    run(this.db, "UPDATE offers SET status = ? WHERE id = ?", status, offer.id);
  }

  // --- sim steps ---------------------------------------------------------------

  private departShips(): void {
    const ships = all<Ship>(this.db, "SELECT * FROM ships WHERE state = 'orbiting' AND flight_json IS NOT NULL");
    for (const ship of ships) {
      const plan = JSON.parse(ship.flight_json!) as FlightPlan;
      if (this.simTime + 1e-6 >= plan.departAt) {
        run(this.db, "UPDATE ships SET state = 'in_transit' WHERE id = ?", ship.id);
        this.log("departure", `${ship.name} departed ${plan.fromBodyId} for ${plan.toBodyId}.`, { public: true, corpId: ship.owner_corp_id, payload: { shipId: ship.id } });
      }
    }
  }

  private arriveShips(): void {
    const ships = all<Ship>(this.db, "SELECT * FROM ships WHERE state = 'in_transit' AND flight_json IS NOT NULL");
    for (const ship of ships) {
      const plan = JSON.parse(ship.flight_json!) as FlightPlan;
      if (this.simTime + 1e-6 >= plan.arriveAt) {
        run(this.db, "UPDATE ships SET state = 'orbiting', body_id = ?, flight_json = NULL WHERE id = ?", plan.toBodyId, ship.id);
        run(this.db, "UPDATE containers SET body_id = ? WHERE ship_id = ?", plan.toBodyId, ship.id);
        this.log("arrival", `${ship.name} arrived at ${plan.toBodyId}.`, { public: true, corpId: ship.owner_corp_id, payload: { shipId: ship.id, bodyId: plan.toBodyId } });
      }
    }
  }

  private finishConstruction(): void {
    const jobs = all<{ id: string; corp_id: string; body_id: string; recipe: string; completes_at: number }>(
      this.db,
      "SELECT * FROM constructions WHERE status = 'building' AND completes_at <= ?",
      this.simTime,
    );
    for (const job of jobs) {
      const recipe = BUILD[job.recipe];
      if (!recipe) continue;
      const corp = this.requireCorp(job.corp_id);
      if (recipe.kind === "facility" && recipe.facilityKind) {
        this.insertFacility(job.corp_id, job.body_id, recipe.facilityKind, `${corp.name} ${recipe.facilityKind}`, recipe.capacity ?? 1, null);
      } else if (recipe.kind === "warehouse") {
        this.insertWarehouse(job.corp_id, job.body_id, `${corp.name} warehouse`, recipe.warehouseTons ?? 400, 0, null, null);
      } else if (recipe.kind === "ship" && recipe.shipClass) {
        this.insertShip(job.corp_id, job.body_id, `${corp.name} ${recipe.shipClass}`, recipe.shipClass, 0, null);
      }
      run(this.db, "UPDATE constructions SET status = 'complete' WHERE id = ?", job.id);
      this.log("construction_done", `${recipe.kind} ${job.recipe} completed at ${job.body_id}.`, { corpId: job.corp_id, public: true, payload: { id: job.id } });
    }
  }

  private economy(step: number): void {
    const days = step / 86400;
    if (days <= 0) return;
    const corps = all<Corp>(this.db, "SELECT * FROM corporations");
    for (const corp of corps) {
      const bodies = new Set<string>();
      for (const fac of all<Facility>(this.db, "SELECT * FROM facilities WHERE owner_corp_id = ? AND active = 1", corp.id)) bodies.add(fac.body_id);
      for (const ship of all<Ship>(this.db, "SELECT * FROM ships WHERE owner_corp_id = ? AND state = 'orbiting'", corp.id)) bodies.add(ship.body_id);
      for (const bodyId of bodies) {
        const facilities = all<Facility>(this.db, "SELECT * FROM facilities WHERE owner_corp_id = ? AND body_id = ? AND active = 1", corp.id, bodyId);
        const ships = all<Ship>(this.db, "SELECT * FROM ships WHERE owner_corp_id = ? AND body_id = ? AND state = 'orbiting'", corp.id, bodyId);
        const people = facilities.reduce((s, f) => s + (WORKERS[f.kind] ?? 20), 0) + ships.reduce((s, sh) => s + sh.crew, 0);
        const lifeNeed = people * LIFE_PER_PERSON_DAY * days;
        const elecNeed = people * ELEC_PER_PERSON_DAY * days;
        const lifeGot = lifeNeed > 0 ? this.draw(corp.id, bodyId, "life_support", lifeNeed) : 0;
        this.draw(corp.id, bodyId, "electronics", elecNeed);
        const partsNeed = (facilities.length * PARTS_PER_FACILITY_DAY + ships.length * PARTS_PER_SHIP_DAY) * days;
        this.draw(corp.id, bodyId, "machinery_parts", partsNeed);
        const fulfill = lifeNeed <= 1e-9 ? 1 : lifeGot / lifeNeed;
        for (const fac of facilities) {
          const condition = fulfill < 0.999 ? Math.max(0.25, fac.condition - 0.15 * days * (1 - fulfill)) : Math.min(1, fac.condition + 0.2 * days);
          if (Math.abs(condition - fac.condition) > 1e-6) run(this.db, "UPDATE facilities SET condition = ? WHERE id = ?", condition, fac.id);
        }
        if (lifeNeed > 0.01 && lifeGot < lifeNeed * 0.5) {
          this.noteShortage(corp.id, bodyId, `${corp.name} is short on life_support at ${bodyId}. Population demand is unmet, so facility output is falling. Stock life_support in local storage.`);
        }
      }
      const flying = all<Ship>(this.db, "SELECT * FROM ships WHERE owner_corp_id = ? AND state = 'in_transit'", corp.id);
      for (const ship of flying) {
        this.drawHold(ship.id, "life_support", ship.crew * LIFE_PER_PERSON_DAY * days);
        this.drawHold(ship.id, "electronics", ship.crew * ELEC_PER_PERSON_DAY * days);
        this.drawHold(ship.id, "machinery_parts", PARTS_PER_SHIP_DAY * days);
      }
      this.produce(corp.id, days);
    }
    this.accrueRent(days);
  }

  private produce(corpId: string, days: number): void {
    const facilities = all<Facility>(this.db, "SELECT * FROM facilities WHERE owner_corp_id = ? AND active = 1", corpId);
    for (const fac of facilities) {
      const mine = MINE_OUTPUT[fac.kind];
      if (mine) {
        const rich = depositOf(fac.body_id, mine);
        const desired = fac.capacity * rich * fac.condition * days;
        this.storeOutput(corpId, fac.body_id, mine, desired);
        continue;
      }
      const recipe = TRANSFORMS[fac.kind];
      if (!recipe) continue;
      let out = fac.capacity * fac.condition * days;
      for (const [input, per] of Object.entries(recipe.inputs)) {
        if (!per) continue;
        out = Math.min(out, this.available(corpId, fac.body_id, input) / per);
      }
      out = Math.min(out, this.freeStorage(corpId, fac.body_id));
      if (out <= 1e-6) continue;
      for (const [input, per] of Object.entries(recipe.inputs)) this.draw(corpId, fac.body_id, input, out * (per ?? 0));
      this.storeOutput(corpId, fac.body_id, recipe.out, out);
    }
  }

  private accrueRent(days: number): void {
    const leases = all<Lease>(this.db, "SELECT * FROM leases WHERE status = 'active'");
    for (const lease of leases) {
      const wh = this.warehouse(lease.warehouse_id);
      const charge = lease.tons * lease.rate_per_ton_day * days;
      let accrued = lease.accrued_unpaid + charge;
      const tenant = this.requireCorp(lease.tenant_corp_id);
      const landlord = this.requireCorp(wh.owner_corp_id);
      const freeCredits = Math.max(0, tenant.credits - tenant.reserved_credits);
      const pay = Math.min(accrued, freeCredits);
      if (pay > 1e-8) {
        run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(tenant.credits - pay), tenant.id);
        run(this.db, "UPDATE corporations SET credits = ? WHERE id = ?", tons(landlord.credits + pay), landlord.id);
        accrued -= pay;
      }
      accrued = tons(Math.max(0, accrued));
      let unpaid = lease.unpaid_since;
      if (accrued <= 1e-6) {
        accrued = 0;
        unpaid = null;
      } else if (unpaid == null) unpaid = this.simTime;
      run(this.db, "UPDATE leases SET accrued_unpaid = ?, unpaid_since = ? WHERE id = ?", accrued, unpaid, lease.id);
    }
  }

  private noteShortage(corpId: string, bodyId: string, message: string): void {
    const key = `${corpId}:${bodyId}:${Math.floor(this.simTime / 86400)}`;
    if (this.shortageDays.has(key)) return;
    this.shortageDays.add(key);
    this.log("shortage", message, { corpId, public: false });
  }

  // --- reads -------------------------------------------------------------------

  population(corpId: string): number {
    let n = 0;
    for (const fac of all<Facility>(this.db, "SELECT * FROM facilities WHERE owner_corp_id = ? AND active = 1", corpId)) n += WORKERS[fac.kind] ?? 20;
    for (const ship of all<Ship>(this.db, "SELECT * FROM ships WHERE owner_corp_id = ?", corpId)) n += ship.crew;
    return n;
  }

  briefing(corpId: string): unknown {
    const corp = this.requireCorp(corpId);
    const bodies = new Set<string>();
    const facilities = all<Facility>(this.db, "SELECT * FROM facilities WHERE owner_corp_id = ?", corpId);
    const ships = all<Ship>(this.db, "SELECT * FROM ships WHERE owner_corp_id = ?", corpId);
    const warehouses = all<Warehouse>(this.db, "SELECT * FROM warehouses WHERE owner_corp_id = ?", corpId);
    const leases = all<Lease>(this.db, "SELECT * FROM leases WHERE tenant_corp_id = ? AND status = 'active'", corpId);
    for (const row of facilities) bodies.add(row.body_id);
    for (const row of ships) bodies.add(row.body_id);
    for (const row of warehouses) bodies.add(row.body_id);
    for (const lease of leases) bodies.add(this.warehouse(lease.warehouse_id).body_id);
    const sites = [...bodies].sort().map((bodyId) => ({
      bodyId,
      inventory: this.inventoryMap(corpId, bodyId),
      freeStorageTons: tons(this.freeStorage(corpId, bodyId)),
      leases: leases
        .filter((l) => this.warehouse(l.warehouse_id).body_id === bodyId)
        .map((l) => ({
          id: l.id,
          warehouseId: l.warehouse_id,
          tons: l.tons,
          rate: l.rate_per_ton_day,
          unpaid: l.accrued_unpaid,
          seizable: this.leaseSeizable(l),
        })),
      warehousesOwned: warehouses.filter((w) => w.body_id === bodyId).map((w) => ({ id: w.id, name: w.name, capacity: w.capacity_tons, listedTons: w.listed_tons, listedRate: w.listed_rate })),
      facilities: facilities.filter((f) => f.body_id === bodyId).map((f) => ({ id: f.id, kind: f.kind, name: f.name, active: f.active === 1, condition: f.condition, askPrice: f.ask_price })),
      ships: ships.filter((s) => s.body_id === bodyId || this.plan(s)?.fromBodyId === bodyId).map((s) => this.shipView(s)),
    }));
    const orders = all<Order>(this.db, "SELECT * FROM orders WHERE corp_id = ? AND status = 'open' ORDER BY created_sim_time", corpId);
    const standing = all(this.db, "SELECT id, body_id, commodity, side, target_tons, limit_price, batch_tons FROM standing_orders WHERE corp_id = ? AND active = 1", corpId);
    const incoming = all(this.db, "SELECT id, from_corp_id, body_id, credits_offered, credits_requested, goods_offered_json, goods_requested_json, note FROM offers WHERE to_corp_id = ? AND status = 'open'", corpId);
    const outgoing = all(this.db, "SELECT id, to_corp_id, body_id, credits_offered, credits_requested, goods_offered_json, goods_requested_json, note, status FROM offers WHERE from_corp_id = ? AND status = 'open'", corpId);
    const messages = all(this.db, "SELECT id, from_corp_id, body_id, content, sim_time FROM messages WHERE to_corp_id = ? ORDER BY sim_time DESC LIMIT 10", corpId);
    const jobs = all(this.db, "SELECT id, body_id, recipe, completes_at, status FROM constructions WHERE corp_id = ? AND status = 'building'", corpId);
    const alerts: string[] = [];
    for (const lease of leases) {
      if (this.leaseSeizable(lease)) alerts.push(`Lease ${lease.id} is seizable by the landlord (unpaid ${lease.accrued_unpaid.toFixed(0)} cr).`);
      else if (lease.accrued_unpaid > 1) alerts.push(`Lease ${lease.id} has unpaid rent of ${lease.accrued_unpaid.toFixed(0)} cr.`);
    }
    for (const ship of ships) {
      if (ship.state === "in_transit") alerts.push(`${ship.name} is in transit to ${this.plan(ship)?.toBodyId}.`);
      else if (ship.flight_json) alerts.push(`${ship.name} is waiting to depart for ${this.plan(ship)?.toBodyId}.`);
    }
    return {
      sim: this.clockView(),
      corp: { id: corp.id, name: corp.name, credits: corp.credits, reservedCredits: corp.reserved_credits, population: this.population(corp.id) },
      sites,
      orders: orders.map((o) => ({ id: o.id, bodyId: o.body_id, commodity: o.commodity, side: o.side, qty: o.qty_remaining, price: o.price })),
      standingOrders: standing,
      offers: {
        incoming: incoming.map((o) => this.offerView(o as unknown as OfferRow)),
        outgoing: outgoing.map((o) => this.offerView(o as unknown as OfferRow)),
      },
      messages,
      constructions: jobs,
      alerts,
    };
  }

  events(corpId: string, since: number): unknown[] {
    return all(
      this.db,
      "SELECT id, sim_time AS t, type, message, payload_json AS payload, public FROM events WHERE id > ? AND (corp_id = ? OR public = 1) ORDER BY id ASC LIMIT 200",
      since,
      corpId,
    ).map((row) => {
      const r = row as { id: number; t: number; type: string; message: string; payload: string; public: number };
      return { id: r.id, t: r.t, type: r.type, message: r.message, payload: JSON.parse(r.payload), public: r.public === 1 };
    });
  }

  market(bodyIdRaw: string): unknown {
    const bodyId = this.body(bodyIdRaw);
    const commodities: Record<string, { bids: unknown[]; asks: unknown[] }> = {};
    for (const commodity of COMMODITIES) {
      const bids = all<Order>(this.db, "SELECT * FROM orders WHERE body_id = ? AND commodity = ? AND side = 'buy' AND status = 'open' ORDER BY price DESC LIMIT 8", bodyId, commodity);
      const asks = all<Order>(this.db, "SELECT * FROM orders WHERE body_id = ? AND commodity = ? AND side = 'sell' AND status = 'open' ORDER BY price ASC LIMIT 8", bodyId, commodity);
      if (bids.length || asks.length) {
        commodities[commodity] = {
          bids: bids.map((o) => ({ id: o.id, qty: o.qty_remaining, price: o.price, corpId: o.corp_id })),
          asks: asks.map((o) => ({ id: o.id, qty: o.qty_remaining, price: o.price, corpId: o.corp_id })),
        };
      }
    }
    const asks = all<Warehouse>(this.db, "SELECT * FROM warehouses WHERE body_id = ? AND listed_tons > 0 AND listed_rate IS NOT NULL", bodyId);
    const bids = all(this.db, "SELECT id, corp_id, tons, max_rate FROM space_bids WHERE body_id = ? AND status = 'open'", bodyId);
    return {
      bodyId,
      simTime: this.simTime,
      fee: FEE,
      commodities,
      space: {
        asks: asks.map((w) => ({ warehouseId: w.id, name: w.name, tons: w.listed_tons, rate: w.listed_rate, ownerCorpId: w.owner_corp_id, capacity: w.capacity_tons })),
        bids,
      },
      assets: this.assetListings(bodyId),
    };
  }

  snapshot(): unknown {
    const ships = all<Ship>(this.db, "SELECT * FROM ships").map((s) => {
      const owner = this.requireCorp(s.owner_corp_id);
      const plan = this.plan(s);
      return {
        id: s.id,
        name: s.name,
        ownerId: owner.id,
        ownerName: owner.name,
        state: s.state,
        bodyId: s.body_id,
        askPrice: s.ask_price,
        crew: s.crew,
        flight: plan
          ? { fromBodyId: plan.fromBodyId, toBodyId: plan.toBodyId, departAt: plan.departAt, arriveAt: plan.arriveAt, frameId: plan.frameId, mu: plan.mu, r0: plan.r0, v0: plan.v0 }
          : null,
      };
    });
    const facilities = all<Facility>(this.db, "SELECT * FROM facilities").map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      bodyId: f.body_id,
      ownerId: f.owner_corp_id,
      ownerName: this.requireCorp(f.owner_corp_id).name,
      askPrice: f.ask_price,
      condition: f.condition,
      active: f.active === 1,
    }));
    const warehouses = all<Warehouse>(this.db, "SELECT * FROM warehouses").map((w) => ({
      id: w.id,
      name: w.name,
      bodyId: w.body_id,
      ownerId: w.owner_corp_id,
      ownerName: this.requireCorp(w.owner_corp_id).name,
      capacity: w.capacity_tons,
      listedTons: w.listed_tons,
      listedRate: w.listed_rate,
      askPrice: w.ask_price,
      storedTons: tons(this.storedTons(this.ownerContainer(w.id).id)),
      leasedTons: tons(this.leasedTons(w.id)),
    }));
    const events = all<{ id: number; sim_time: number; type: string; message: string }>(
      this.db,
      "SELECT id, sim_time, type, message FROM events WHERE public = 1 ORDER BY id DESC LIMIT 40",
    ).reverse();
    return { clock: this.clockView(), ships, facilities, warehouses, events, leaderboard: this.leaderboard() };
  }

  leaderboard(): unknown[] {
    return all<Corp>(this.db, "SELECT * FROM corporations")
      .map((c) => ({
        id: c.id,
        name: c.name,
        credits: c.credits,
        population: this.population(c.id),
        ships: get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM ships WHERE owner_corp_id = ?", c.id)?.n ?? 0,
        facilities: get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM facilities WHERE owner_corp_id = ?", c.id)?.n ?? 0,
        legacy: c.legacy === 1,
      }))
      .sort((a, b) => b.credits - a.credits);
  }

  profile(corpId: string): unknown {
    const corp = this.requireCorp(corpId);
    const row = this.leaderboard().find((c) => (c as { id: string }).id === corp.id) as Record<string, unknown>;
    const ships = all<Ship>(this.db, "SELECT * FROM ships WHERE owner_corp_id = ?", corp.id).map((s) => this.shipView(s));
    const facilities = all<Facility>(this.db, "SELECT id, name, kind, body_id, condition, ask_price FROM facilities WHERE owner_corp_id = ?", corp.id);
    return { ...row, ships, facilities };
  }

  bodiesPayload(): unknown[] {
    return BODIES.map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.kind,
      parentId: b.parentId,
      radiusKm: b.radiusKm,
      color: b.color,
      systemView: b.systemView,
      deposits: DEPOSITS[b.id] ?? {},
    }));
  }

  // --- helpers -----------------------------------------------------------------

  private body(id: string): string {
    const body = tryBody(str(id, "bodyId"));
    if (!body) {
      throw new ApiError(400, "unknown_body", `Unknown body "${id}". Call GET /api/world/bodies for ids such as earth, moon, mars, ceres, europa.`);
    }
    return body.id;
  }

  private commodity(id: string): Commodity {
    const value = str(id, "commodity");
    if (!isCommodity(value)) {
      throw new ApiError(400, "unknown_commodity", `Unknown commodity "${value}". Use one of: ${COMMODITIES.join(", ")}.`);
    }
    return value;
  }

  private goods(lines: GoodLine[]): GoodLine[] {
    if (!Array.isArray(lines)) throw new ApiError(400, "bad_goods", "goods must be an array of {commodity, tons}.");
    return lines.map((line) => ({ commodity: this.commodity(line.commodity), tons: pos(line.tons, "tons") }));
  }

  private ship(id: string): Ship {
    const row = get<Ship>(this.db, "SELECT * FROM ships WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No ship ${id}.`);
    return row;
  }

  private ownShip(corpId: string, id: string): Ship {
    const row = this.ship(id);
    if (row.owner_corp_id !== corpId) throw new ApiError(403, "not_owner", "You do not own that ship.");
    return row;
  }

  private facility(id: string): Facility {
    const row = get<Facility>(this.db, "SELECT * FROM facilities WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No facility ${id}.`);
    return row;
  }

  private warehouse(id: string): Warehouse {
    const row = get<Warehouse>(this.db, "SELECT * FROM warehouses WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No warehouse ${id}. Market listings include warehouseId.`);
    return row;
  }

  private lease(id: string): Lease {
    const row = get<Lease>(this.db, "SELECT * FROM leases WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No lease ${id}. Your leases are listed in GET /api/me/briefing.`);
    return row;
  }

  private offer(id: string): OfferRow {
    const row = get<OfferRow>(this.db, "SELECT * FROM offers WHERE id = ?", id);
    if (!row) throw new ApiError(404, "not_found", `No offer ${id}.`);
    return row;
  }

  private hold(shipId: string): Container {
    const row = get<Container>(this.db, "SELECT * FROM containers WHERE ship_id = ? AND kind = 'hold'", shipId);
    if (!row) throw new ApiError(500, "corrupt", `Ship ${shipId} has no cargo hold.`);
    return row;
  }

  private assertDocked(ship: Ship): void {
    if (ship.state !== "orbiting" || ship.flight_json) {
      const plan = this.plan(ship);
      throw new ApiError(
        400,
        "ship_not_docked",
        ship.state === "in_transit"
          ? `${ship.name} is in transit to ${plan?.toBodyId} and cannot load, unload, or be redirected. It arrives at sim time ${plan?.arriveAt}.`
          : `${ship.name} has a filed departure. Cancel it with POST /api/ships/${ship.id}/cancel-launch before changing cargo.`,
      );
    }
  }

  private plan(ship: Ship): FlightPlan | null {
    if (!ship.flight_json) return null;
    return JSON.parse(ship.flight_json) as FlightPlan;
  }

  private shipView(ship: Ship): unknown {
    const plan = this.plan(ship);
    const hold = this.hold(ship.id);
    return {
      id: ship.id,
      name: ship.name,
      class: ship.class,
      state: ship.state,
      bodyId: ship.body_id,
      tank: ship.tank_tons,
      tankCapacity: ship.tank_capacity,
      cargo: this.inventoryMap(ship.owner_corp_id, ship.body_id) && this.holdInventory(hold.id),
      cargoCapacity: ship.cargo_capacity,
      askPrice: ship.ask_price,
      flight: plan ? { toBodyId: plan.toBodyId, fromBodyId: plan.fromBodyId, departAt: plan.departAt, arriveAt: plan.arriveAt, deltaV: plan.deltaV } : null,
    };
  }

  private holdInventory(holdId: string): Record<string, number> {
    const map: Record<string, number> = {};
    for (const lot of all<Lot>(this.db, "SELECT * FROM lots WHERE container_id = ?", holdId)) map[lot.commodity] = lot.tons;
    return map;
  }

  private offerView(o: OfferRow): unknown {
    return {
      id: o.id,
      fromCorpId: o.from_corp_id,
      toCorpId: o.to_corp_id,
      bodyId: o.body_id,
      creditsOffered: o.credits_offered,
      creditsRequested: o.credits_requested,
      goodsOffered: JSON.parse(o.goods_offered_json),
      goodsRequested: JSON.parse(o.goods_requested_json),
      note: o.note,
      status: o.status,
    };
  }

  private assetListings(bodyId: string): unknown[] {
    const ships = all<Ship>(this.db, "SELECT * FROM ships WHERE body_id = ? AND ask_price IS NOT NULL AND state = 'orbiting'", bodyId).map((s) => ({
      assetType: "ship",
      assetId: s.id,
      name: s.name,
      kind: s.class,
      price: s.ask_price,
      ownerCorpId: s.owner_corp_id,
    }));
    const facilities = all<Facility>(this.db, "SELECT * FROM facilities WHERE body_id = ? AND ask_price IS NOT NULL", bodyId).map((f) => ({
      assetType: "facility",
      assetId: f.id,
      name: f.name,
      kind: f.kind,
      price: f.ask_price,
      ownerCorpId: f.owner_corp_id,
    }));
    const warehouses = all<Warehouse>(this.db, "SELECT * FROM warehouses WHERE body_id = ? AND ask_price IS NOT NULL", bodyId).map((w) => ({
      assetType: "warehouse",
      assetId: w.id,
      name: w.name,
      kind: "warehouse",
      price: w.ask_price,
      ownerCorpId: w.owner_corp_id,
    }));
    return [...ships, ...facilities, ...warehouses];
  }

  private log(type: string, message: string, opts: { corpId?: string | null; public?: boolean; payload?: unknown }): void {
    run(
      this.db,
      "INSERT INTO events (sim_time, type, corp_id, public, message, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      this.simTime,
      type,
      opts.corpId ?? null,
      opts.public ? 1 : 0,
      message,
      JSON.stringify(opts.payload ?? {}),
    );
  }

  private insertFacility(corpId: string, bodyId: string, kind: string, name: string, capacity: number, ask: number | null): string {
    const id = nid("fac");
    run(
      this.db,
      "INSERT INTO facilities (id, body_id, owner_corp_id, kind, name, capacity, active, ask_price, condition, created_sim_time) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?)",
      id,
      bodyId,
      corpId,
      kind,
      name,
      capacity,
      ask,
      this.simTime,
    );
    return id;
  }

  private insertWarehouse(corpId: string, bodyId: string, name: string, capacity: number, listed: number, rate: number | null, ask: number | null): string {
    const id = nid("wh");
    run(
      this.db,
      "INSERT INTO warehouses (id, body_id, owner_corp_id, name, capacity_tons, listed_tons, listed_rate, ask_price, created_sim_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      bodyId,
      corpId,
      name,
      capacity,
      listed,
      rate,
      ask,
      this.simTime,
    );
    run(
      this.db,
      "INSERT INTO containers (id, kind, body_id, owner_corp_id, capacity_tons, warehouse_id, lease_id, ship_id) VALUES (?, 'warehouse_owner', ?, ?, ?, ?, NULL, NULL)",
      nid("box"),
      bodyId,
      corpId,
      capacity,
      id,
    );
    return id;
  }

  private insertShip(corpId: string, bodyId: string, name: string, cls: string, tank: number, ask: number | null): string {
    const spec = SHIP_CLASSES[cls];
    if (!spec) throw new ApiError(500, "bad_class", `Unknown ship class ${cls}.`);
    const id = nid("ship");
    run(
      this.db,
      "INSERT INTO ships (id, owner_corp_id, name, class, state, body_id, dry_mass_tons, isp_s, tank_tons, tank_capacity, cargo_capacity, crew, ask_price, flight_json, created_sim_time) VALUES (?, ?, ?, ?, 'orbiting', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      id,
      corpId,
      name,
      cls,
      bodyId,
      spec.dry,
      spec.isp,
      Math.min(tank, spec.tank),
      spec.tank,
      spec.cargo,
      spec.crew,
      ask,
      this.simTime,
    );
    run(
      this.db,
      "INSERT INTO containers (id, kind, body_id, owner_corp_id, capacity_tons, warehouse_id, lease_id, ship_id) VALUES (?, 'hold', ?, ?, ?, NULL, NULL, ?)",
      nid("box"),
      bodyId,
      corpId,
      spec.cargo,
      id,
    );
    return id;
  }

  private stock(corpId: string, bodyId: string, commodity: string, amount: number): void {
    const boxes = this.groundContainers(corpId, bodyId);
    const box = boxes.find((c) => c.kind === "warehouse_owner") ?? boxes[0];
    if (!box) return;
    this.addCommodity(box.id, commodity, amount);
  }

  private foundLegacy(name: string): string {
    const id = nid("corp");
    run(
      this.db,
      "INSERT INTO corporations (id, name, token_hash, credits, reserved_credits, legacy, created_sim_time) VALUES (?, ?, ?, ?, 0, 1, ?)",
      id,
      name,
      hashToken(newToken()),
      name.startsWith("Terra") ? 5_000_000 : 2_000_000,
      this.simTime,
    );
    return id;
  }

  private seed(): void {
    const terra = this.foundLegacy("Terra Directorate");
    const luna = this.foundLegacy("Luna Compact");
    const mars = this.foundLegacy("Mars Authority");

    const whTerra = this.insertWarehouse(terra, "earth", "Quito Depot", 12000, 3000, 2, null);
    this.insertWarehouse(luna, "moon", "Shackleton Vault", 6000, 1500, 1.5, null);
    this.insertWarehouse(mars, "mars", "Hellas Stores", 8000, 2000, 1.5, null);
    void whTerra;

    this.insertFacility(terra, "earth", "mine_metal", "Atacama Open Pit", 18, null);
    this.insertFacility(terra, "earth", "refinery_metals", "Escondida Metals", 8, null);
    this.insertFacility(terra, "earth", "factory_parts", "Quito Machine Works", 4, null);
    this.insertFacility(terra, "earth", "factory_electronics", "Guayaquil Electronics", 1.2, null);
    this.insertFacility(terra, "earth", "factory_life_support", "Amazon Closed Loop", 5, null);
    this.insertFacility(terra, "earth", "shipyard", "Kourou Yard", 1, null);

    this.insertFacility(luna, "moon", "mine_water", "Shackleton Ice", 10, null);
    this.insertFacility(luna, "moon", "mine_metal", "Mare Regolith", 8, null);
    this.insertFacility(luna, "moon", "mine_rare", "Aitken Prospect", 3, null);
    this.insertFacility(luna, "moon", "refinery_propellant", "Peak Electrolysis", 6, null);
    this.insertFacility(luna, "moon", "refinery_metals", "Luna Metals", 4, null);
    this.insertFacility(luna, "moon", "mine_rare", "Retired Prospector", 2, 28000);

    this.insertFacility(mars, "mars", "mine_water", "Korolev Ice", 12, null);
    this.insertFacility(mars, "mars", "mine_metal", "Tharsis Cut", 10, null);
    this.insertFacility(mars, "mars", "refinery_propellant", "Hellas LOX/LH2", 8, null);
    this.insertFacility(mars, "mars", "factory_life_support", "Valles Greenhouse", 4, null);
    this.insertFacility(mars, "mars", "shipyard", "Mariner Yard", 1, null);

    this.stock(terra, "earth", "metal_ore", 400);
    this.stock(terra, "earth", "refined_metals", 350);
    this.stock(terra, "earth", "machinery_parts", 180);
    this.stock(terra, "earth", "electronics", 40);
    this.stock(terra, "earth", "life_support", 250);
    this.stock(terra, "earth", "propellant", 220);
    this.stock(terra, "earth", "water_ice", 80);
    this.stock(terra, "earth", "rare_minerals", 15);

    this.stock(luna, "moon", "water_ice", 300);
    this.stock(luna, "moon", "metal_ore", 120);
    this.stock(luna, "moon", "rare_minerals", 40);
    this.stock(luna, "moon", "propellant", 260);
    this.stock(luna, "moon", "refined_metals", 80);
    this.stock(luna, "moon", "life_support", 60);
    this.stock(luna, "moon", "machinery_parts", 40);

    this.stock(mars, "mars", "water_ice", 280);
    this.stock(mars, "mars", "metal_ore", 160);
    this.stock(mars, "mars", "propellant", 300);
    this.stock(mars, "mars", "life_support", 120);
    this.stock(mars, "mars", "refined_metals", 70);
    this.stock(mars, "mars", "machinery_parts", 30);

    this.insertShip(terra, "earth", "Surplus Hauler", "hauler", SHIP_CLASSES.hauler!.tank, 35000);
    this.insertShip(terra, "earth", "Directorate Runner", "hauler", 80, null);
    this.insertShip(luna, "moon", "Compact Tanker", "tanker", SHIP_CLASSES.tanker!.tank, 48000);
    this.insertShip(mars, "mars", "Authority Hauler", "hauler", SHIP_CLASSES.hauler!.tank, 36000);

    this.placeOrder(terra, { bodyId: "earth", commodity: "propellant", side: "sell", quantity: 80, price: 180 });
    this.placeOrder(terra, { bodyId: "earth", commodity: "machinery_parts", side: "sell", quantity: 30, price: 450 });
    this.placeOrder(luna, { bodyId: "moon", commodity: "propellant", side: "sell", quantity: 100, price: 160 });
    this.placeOrder(luna, { bodyId: "moon", commodity: "water_ice", side: "sell", quantity: 80, price: 70 });
    this.placeOrder(mars, { bodyId: "mars", commodity: "life_support", side: "sell", quantity: 40, price: 300 });
    this.placeOrder(terra, { bodyId: "earth", commodity: "water_ice", side: "buy", quantity: 40, price: 90 });

    this.placeStanding(terra, { bodyId: "earth", commodity: "water_ice", side: "buy", targetTons: 300, limitPrice: 100, batchTons: 40 });
    this.placeStanding(terra, { bodyId: "earth", commodity: "machinery_parts", side: "sell", targetTons: 80, limitPrice: 450, batchTons: 20 });
    this.placeStanding(luna, { bodyId: "moon", commodity: "propellant", side: "sell", targetTons: 80, limitPrice: 160, batchTons: 30 });
    this.placeStanding(mars, { bodyId: "mars", commodity: "life_support", side: "sell", targetTons: 40, limitPrice: 300, batchTons: 15 });

    this.log("world", "Legacy agencies Terra Directorate, Luna Compact, and Mars Authority are on the books. Every tonne they hold is for sale or for their own people.", { public: true });
    run(this.db, "INSERT INTO meta (key, value) VALUES ('seeded', '1')");
  }
}

interface OfferRow {
  id: string;
  from_corp_id: string;
  to_corp_id: string;
  body_id: string;
  credits_offered: number;
  credits_requested: number;
  goods_offered_json: string;
  goods_requested_json: string;
  note: string | null;
  status: string;
}
