import { useEffect, useRef, useState } from "react";
import { getBody } from "@acs/astro";
import { mountScene, type Focus, type ShipView } from "./scene";

interface Clock {
  simTime: number;
  speed: number;
  paused: boolean;
  iso: string;
}

interface Snapshot {
  clock: Clock;
  ships: Array<ShipView & { ownerName: string }>;
  facilities: Array<{ id: string; name: string; kind: string; bodyId: string; ownerName: string; askPrice: number | null; condition: number }>;
  warehouses: Array<{ id: string; name: string; bodyId: string; ownerName: string; capacity: number; listedTons: number; listedRate: number | null; storedTons: number; leasedTons: number }>;
  events: Array<{ id: number; sim_time: number; type: string; message: string }>;
  leaderboard: Array<{ id: string; name: string; credits: number; population: number; ships: number; facilities: number; legacy: boolean }>;
}

interface Market {
  commodities: Record<string, { bids: Array<{ qty: number; price: number }>; asks: Array<{ qty: number; price: number }> }>;
  space: { asks: Array<{ name: string; tons: number; rate: number; ownerCorpId: string }> };
  assets: Array<{ name: string; kind: string; price: number; assetType: string }>;
}

const SPEEDS = [1, 60, 240, 1000, 10000];

function parentOf(id: string): string | null {
  return getBody(id).parentId;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const live = useRef({ simTime: 0, speed: 60, paused: false, at: performance.now(), focus: { level: "system" } as Focus, ships: [] as ShipView[] });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [focus, setFocus] = useState<Focus>({ level: "system" });
  const [selected, setSelected] = useState("earth");
  const [corpId, setCorpId] = useState<string | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    live.current.focus = focus;
  }, [focus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const labels = labelRef.current;
    if (!canvas || !labels) return;
    return mountScene(canvas, labels, {
      getSimTime: () => {
        const liveClock = live.current;
        if (liveClock.paused) return liveClock.simTime;
        return liveClock.simTime + ((performance.now() - liveClock.at) / 1000) * liveClock.speed;
      },
      getFocus: () => live.current.focus,
      getShips: () => live.current.ships,
      onPick: (id) => {
        if (id === "sun") {
          setFocus({ level: "system" });
          setSelected("sun");
          return;
        }
        const body = getBody(id);
        if (body.kind === "moon") setFocus({ level: "moon", id });
        else setFocus({ level: "planet", id });
        setSelected(id);
      },
    });
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    const apply = (next: Snapshot) => {
      live.current.simTime = next.clock.simTime;
      live.current.speed = next.clock.speed;
      live.current.paused = next.clock.paused;
      live.current.at = performance.now();
      live.current.ships = next.ships;
      setSnapshot(next);
    };
    const pull = async () => {
      const res = await fetch("/api/world/snapshot");
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      apply(await res.json());
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const next = new WebSocket(`${proto}://${location.host}/ws`);
      socket = next;
      next.onopen = () => {
        if (!stopped) setConnected(true);
      };
      next.onclose = () => {
        if (stopped) return;
        setConnected(false);
        retry = setTimeout(connect, 1000);
      };
      next.onmessage = (event) => {
        const msg = JSON.parse(event.data) as { type: string; snapshot: Snapshot };
        if (msg.type === "world") apply(msg.snapshot);
      };
    };
    pull().catch((err: unknown) => setError(err instanceof Error ? err.message : "snapshot failed"));
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      const current = socket;
      if (!current) return;
      current.onclose = null;
      if (current.readyState === WebSocket.OPEN) current.close();
      else current.onopen = () => current.close();
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    fetch(`/api/markets/${selected}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancel) setMarket(data);
      })
      .catch(() => {
        if (!cancel) setMarket(null);
      });
    return () => {
      cancel = true;
    };
  }, [selected]);

  const setSpeed = async (speed: number) => {
    await fetch("/api/sim/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ speed, paused: false }) });
  };
  const setPaused = async (paused: boolean) => {
    await fetch("/api/sim/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused }) });
  };

  const planetId = focus.level === "planet" ? focus.id : focus.level === "moon" ? parentOf(focus.id) : null;
  const corp = snapshot?.leaderboard.find((row) => row.id === corpId) ?? null;
  const bodyFacilities = snapshot?.facilities.filter((row) => row.bodyId === selected) ?? [];
  const bodyShips = snapshot?.ships.filter((row) => row.state === "orbiting" && row.bodyId === selected) ?? [];
  const bodyWarehouses = snapshot?.warehouses.filter((row) => row.bodyId === selected) ?? [];
  const corpShips = snapshot?.ships.filter((row) => corp && row.ownerName === corp.name) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <b>ACS</b>
          <span>Anarcho-Capitalism in Space</span>
        </div>
        <div className="clock">
          {snapshot ? snapshot.clock.iso.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "connecting"}
          <small>{snapshot ? `${snapshot.clock.speed}×` : ""}</small>
        </div>
        <span className="status">{error ? error : connected ? "live" : "reconnecting"}</span>
        <div className="speeds">
          <button className={snapshot?.clock.paused ? "on" : ""} onClick={() => void setPaused(!snapshot?.clock.paused)}>
            {snapshot?.clock.paused ? "Resume" : "Pause"}
          </button>
          {SPEEDS.map((speed) => (
            <button key={speed} className={snapshot?.clock.speed === speed && !snapshot.clock.paused ? "on" : ""} onClick={() => void setSpeed(speed)}>
              {speed}×
            </button>
          ))}
        </div>
      </header>
      <div className="stage">
        <canvas ref={canvasRef} />
        <div className="labels" ref={labelRef} />
        <nav className="crumb">
          <button
            className={focus.level === "system" ? "on" : ""}
            onClick={() => {
              setFocus({ level: "system" });
              setSelected("sun");
            }}
          >
            Solar System
          </button>
          {planetId && (
            <>
              <i>/</i>
              <button
                className={focus.level === "planet" ? "on" : ""}
                onClick={() => {
                  setFocus({ level: "planet", id: planetId });
                  setSelected(planetId);
                }}
              >
                {getBody(planetId).name}
              </button>
            </>
          )}
          {focus.level === "moon" && (
            <>
              <i>/</i>
              <button className="on">{getBody(focus.id).name}</button>
            </>
          )}
        </nav>
        <aside className="dock left">
          <h2>Corporations</h2>
          {(snapshot?.leaderboard ?? []).map((row) => (
            <button key={row.id} className={row.id === corpId ? "rowbtn on" : "rowbtn"} onClick={() => setCorpId(row.id)}>
              <span>{row.name}</span>
              <span className="num">{Math.round(row.credits).toLocaleString()}</span>
            </button>
          ))}
          {corp && (
            <>
              <h2>{corp.name}</h2>
              <p className="muted">
                {corp.legacy ? "Legacy agency. " : ""}
                Population {corp.population.toLocaleString()}. {corp.ships} ships, {corp.facilities} facilities.
              </p>
              <p className="muted">Credits {Math.round(corp.credits).toLocaleString()}.</p>
              {corpShips.map((ship) => (
                <p key={ship.id} className="muted">
                  {ship.name}: {ship.state === "in_transit" ? `in transit to ${ship.flight?.toBodyId}` : `orbiting ${ship.bodyId}`}
                </p>
              ))}
            </>
          )}
          <h2>Events</h2>
          <ul className="feed">
            {(snapshot?.events ?? []).slice(-12).reverse().map((event) => (
              <li key={event.id}>
                <time>{event.type.replaceAll("_", " ")}</time>
                {event.message}
              </li>
            ))}
          </ul>
        </aside>
        <aside className="dock right">
          <h2>{getBody(selected).name}</h2>
          <p className="muted">
            {getBody(selected).kind}
            {getBody(selected).parentId ? ` of ${getBody(getBody(selected).parentId!).name}` : ""}. Click a body to focus its orbit.
          </p>
          <h2>Market</h2>
          {market && Object.keys(market.commodities).length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Commodity</th>
                  <th>Bid</th>
                  <th>Ask</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(market.commodities).map(([name, book]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="num">{book.bids[0] ? book.bids[0].price : "—"}</td>
                    <td className="num">{book.asks[0] ? book.asks[0].price : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No resting commodity orders.</p>
          )}
          <h2>Warehouses</h2>
          {bodyWarehouses.length === 0 && <p className="muted">No warehouses here.</p>}
          {bodyWarehouses.map((row) => (
            <p key={row.id} className="muted">
              {row.name} · {row.ownerName}. {Math.round(row.capacity)} t, {Math.round(row.leasedTons)} t leased
              {row.listedRate != null ? `, ${Math.round(row.listedTons)} t listed at ${row.listedRate} cr/t/day` : ""}.
            </p>
          ))}
          <h2>Facilities</h2>
          {bodyFacilities.length === 0 && <p className="muted">No facilities here.</p>}
          {bodyFacilities.map((row) => (
            <p key={row.id} className="muted">
              {row.name} ({row.kind}) · {row.ownerName}
              {row.askPrice != null ? ` · listed ${row.askPrice.toLocaleString()} cr` : ""}
            </p>
          ))}
          <h2>Orbiting ships</h2>
          {bodyShips.length === 0 && <p className="muted">No ships in orbit.</p>}
          {bodyShips.map((row) => (
            <p key={row.id} className="muted">
              {row.name}
            </p>
          ))}
          {market && market.assets.length > 0 && (
            <>
              <h2>For sale</h2>
              {market.assets.map((asset) => (
                <p key={asset.name + asset.assetType} className="muted">
                  {asset.name} · {asset.kind} · {asset.price.toLocaleString()} cr
                </p>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
