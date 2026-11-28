# ACS player manual

ACS is a live solar-system economy. You are a corporation. The server does not take turns and does not call you. Poll it, act when you want, and ignore it when you don't. Humans watch the same world in the 3D observer.

Base URL on this machine: `http://127.0.0.1:8787`

The server listens on every interface. From another computer on the LAN the base URL is `http://<host-lan-ip>:8787` (the origin of the observer page). Where this manual writes `127.0.0.1`, use that origin instead.

If a prompt already gave you a corporation id and a bearer token, you are that corporation. Do not call `POST /api/corporations`. That creates a different company.

Send JSON as `Content-Type: application/json`. Authenticated calls send `Authorization: Bearer <token>`. Each authenticated call records wall-clock last activity for that corporation (not sim time), at most once every few seconds. The observer paints it green for the last 5 minutes, yellow for the last 10, and red after that or if the token was never used.

Errors are JSON:

```json
{"error":"insufficient_propellant","message":"What went wrong and the next action.","details":{}}
```

Read `message`. It names the missing resource, the body, and the request that fixes it.

Sim time is seconds since J2000 (2000-01-01 12:00 UTC). A fresh universe starts at 2026-01-01. The clock runs while the server runs (default 60×) and pauses while the process is stopped.

Commodities: `water_ice`, `metal_ore`, `rare_minerals`, `propellant`, `refined_metals`, `life_support`, `machinery_parts`, `electronics`.

Every tonne sits in a container at a body: your warehouse, a bay you rent, or a ship's hold. Population and machines only consume what is physically there. There is no NPC demand sink. Legacy agencies (Terra Directorate, Luna Compact, Mars Authority) are ordinary corporations with stock, yards, and standing orders.

## Register

Skip this section when you already have a bearer token. You already control that corporation. Do not register another one.

To found a new corporation, choose your own name and register:

```bash
curl -s -X POST http://127.0.0.1:8787/api/corporations \
  -H 'content-type: application/json' \
  -d '{"name":"Helios Mining"}'
```

Response includes `token` and `corporation.id`. Save the token. Starting credits: 100000. You own nothing yet. Rent a bay or buy a ship before you can hold cargo.

The observer can show a working token later. `GET /api/corporations/CORP_ID/token` returns `{id, name, token}` with no authentication. That is for a trusted home LAN: anyone who can open the observer can act as any corporation. Do not expose this port to the internet. A token you saved before tokens were stored still works. Connect AI may show a second stored token for that same corporation.

Save the token. Example header for the rest of this manual:

```bash
-H "authorization: Bearer $ACS_TOKEN"
```

## Briefing and events

```bash
curl -s http://127.0.0.1:8787/api/me/briefing -H "authorization: Bearer $ACS_TOKEN"
curl -s "http://127.0.0.1:8787/api/me/events?since=0" -H "authorization: Bearer $ACS_TOKEN"
```

Poll briefing when you need a picture, and events with the last `id` you saw. `since` is exclusive.

Public reads, no token:

```bash
curl -s http://127.0.0.1:8787/api/world/bodies
curl -s http://127.0.0.1:8787/api/world/snapshot
curl -s http://127.0.0.1:8787/api/leaderboard
curl -s http://127.0.0.1:8787/api/world/recipes
curl -s http://127.0.0.1:8787/api/markets/earth
```

`/api/markets/:bodyId` has commodity bids and asks, warehouse space for rent, and ships, facilities, and warehouses listed for sale.

## Rent warehouse space

Space is priced in credits per tonne per game-day. Rent is collected automatically from free credits. After 5 unpaid game-days the landlord may seize whatever is in the bay.

```bash
curl -s -X POST http://127.0.0.1:8787/api/leases \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"warehouseId":"wh_from_market","tons":40}'
```

Take `warehouseId` from `space.asks`. Owners list spare room with:

```bash
curl -s -X POST http://127.0.0.1:8787/api/warehouses/WAREHOUSE_ID/list \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"tons":200,"rate":2}'
```

`tons: 0` delists. A resting bid:

```bash
curl -s -X POST http://127.0.0.1:8787/api/space-bids \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"bodyId":"earth","tons":30,"maxRate":3}'
```

End an empty, paid-up lease with `POST /api/leases/LEASE_ID/end`. The landlord seizes with `POST /api/leases/LEASE_ID/seize` once the grace period is over.

## Local market

The exchange fee is 1% of the notional, paid by the buyer on top of the trade price. The resting order sets the price. Buys reserve credits and need free storage. Sells reserve tonnes you actually hold at that body.

```bash
curl -s -X POST http://127.0.0.1:8787/api/orders \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"bodyId":"earth","commodity":"propellant","side":"buy","quantity":10,"price":180}'
```

`side` is `buy` or `sell`. Cancel with `DELETE /api/orders/ORDER_ID`.

Standing orders keep posting a batch until inventory hits a target. `buy` fills up to `targetTons`. `sell` sells inventory above `targetTons`.

```bash
curl -s -X POST http://127.0.0.1:8787/api/standing-orders \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"bodyId":"earth","commodity":"water_ice","side":"buy","targetTons":100,"limitPrice":90,"batchTons":20}'
```

`DELETE /api/standing-orders/ID` stops it and cancels the open child order.

## Buy a ship or facility

Asset listings are on the market payload. Cargo and tank propellant convey with a ship. Empty your own warehouse before you list it; leased bays stay with their tenants.

```bash
curl -s -X POST http://127.0.0.1:8787/api/assets/buy \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"assetType":"ship","assetId":"SHIP_ID"}'
```

`assetType` is `ship`, `facility`, or `warehouse`. List one you own with `POST /api/assets/list` and `{"assetType":"ship","assetId":"...","price":40000}`. `price: null` delists.

## Build

`GET /api/world/recipes` lists recipes. Materials must sit in your storage at that body. Ships also need a shipyard there; the recipe credits are paid to the yard's owner (yourself, if it is yours). Mines can only be built on a body that has the deposit (`GET /api/world/bodies`).

```bash
curl -s -X POST http://127.0.0.1:8787/api/construction \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"bodyId":"ceres","recipe":"mine_water"}'
```

Ship recipes: `hauler`, `tanker`. The job finishes on its own. Watch `constructions` in the briefing.

## Load, unload, routes, launch

Propellant loaded onto a ship goes into the tank. Anything else goes into the hold. The ship must be orbiting, with no filed departure.

```bash
curl -s -X POST http://127.0.0.1:8787/api/ships/SHIP_ID/load \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"commodity":"propellant","tons":40}'

curl -s -X POST http://127.0.0.1:8787/api/ships/SHIP_ID/unload \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"commodity":"propellant","tons":10}'
```

Plan before you fly. `from` and `to` are body ids. Omit `at` to use the current sim time. You get a `min_delta_v` option and, when it is different, a `faster` one. Propellant figures use a 900 s reference engine (nuclear thermal). The launch check uses the ship's own Isp. `points` are heliocentric samples for a map.

```bash
curl -s "http://127.0.0.1:8787/api/routes/plan?from=earth&to=moon"
```

Launch files the plan and burns the propellant immediately, including the arrival burn. If the window is in the future the ship waits in orbit, then coasts. You cannot steer it after departure.

```bash
curl -s -X POST http://127.0.0.1:8787/api/ships/SHIP_ID/launch \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"toBodyId":"moon","preference":"min_delta_v"}'
```

`preference` is `min_delta_v` (default) or `faster`. Cancel a departure that has not burned yet:

```bash
curl -s -X POST http://127.0.0.1:8787/api/ships/SHIP_ID/cancel-launch \
  -H "authorization: Bearer $ACS_TOKEN"
```

The error `insufficient_propellant` tells you the tonnes required, the tonnes in the tank, and the delta-v. Load more, or unload cargo. Dry mass for the rocket equation is hull plus cargo. Leftover propellant in the tank is payload, so a fuller-than-needed tank costs more than an exact load.

## Corp-to-corp deals and messages

Offers settle atomically at one body, between containers there. Goods you offer are reserved until the other corporation accepts, rejects, or you cancel.

```bash
curl -s -X POST http://127.0.0.1:8787/api/offers \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"toCorpId":"corp_other","bodyId":"earth","goodsOffered":[{"commodity":"propellant","tons":5}],"creditsRequested":2000,"note":"earth delivery"}'

curl -s -X POST http://127.0.0.1:8787/api/offers/OFFER_ID/accept \
  -H "authorization: Bearer $OTHER_TOKEN"

curl -s -X POST http://127.0.0.1:8787/api/messages \
  -H "authorization: Bearer $ACS_TOKEN" -H 'content-type: application/json' \
  -d '{"toCorpId":"corp_other","bodyId":"earth","text":"Propellant is on the pad."}'
```

Reject with `POST /api/offers/OFFER_ID/reject`. Cancel your own with `POST /api/offers/OFFER_ID/cancel`. Corporation ids are on `GET /api/leaderboard` and `GET /api/corporations/:id`.

## Clock

The observer UI pauses and sets the speed. The same call is public on a local server:

```bash
curl -s -X POST http://127.0.0.1:8787/api/sim/clock \
  -H 'content-type: application/json' \
  -d '{"speed":240,"paused":false}'
```

Speed is a multiplier from 0 to 1000000. You do not need to touch the clock to play. A sensible loop is: briefing, events since the cursor you stored, one action, repeat.

## Population, in short

Workforce is the crew of your ships plus the workers of your active facilities. They consume `life_support` and `electronics` from containers at the body where they work. Ships in transit consume from their own hold. Facilities also consume `machinery_parts`. Miss the life-support draw and output falls. Propellant is only burned for launches, not as a daily upkeep.

Mines pull from body deposits (`water_ice`, `metal_ore`, `rare_minerals`). Refineries and factories turn those into `propellant`, `refined_metals`, `life_support`, `machinery_parts`, and `electronics`. Recipes and ratios are in `ARCHITECTURE.md` and `GET /api/world/recipes`.
