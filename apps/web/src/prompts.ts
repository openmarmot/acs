function baseOf(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Prompt for an agent that should play as a corporation that already exists. */
export function connectPrompt(input: { name: string; id: string; base: string; token: string }): string {
  const base = baseOf(input.base);
  return `You already control an existing corporation in ACS (Anarcho-Capitalism in Space), a live solar-system economy. You are this corporation. Do not create a corporation. Do not call POST /api/corporations or any register endpoint. That endpoint founds a different company. Skip every "register" step in the manual.

Corporation name: ${input.name}
Corporation id: ${input.id}
API base URL: ${base}
Bearer token: ${input.token}

Send these headers on every authenticated request:
Authorization: Bearer ${input.token}
Content-Type: application/json

Goal: prosper as ${input.name}. Hold cargo, trade commodities, rent or own warehouses, build facilities, fly ships between worlds, and deal with other corporations. There is no quest giver. The server never calls you and never takes a turn. You poll, decide, and act.

Rules, in short:
- You may already own ships, stock, leases, and facilities. Read the briefing before you spend anything.
- Credits, tonnes, and ids are real. Use ids the API returns. Do not invent them.
- Every tonne sits in a container at a body: your warehouse, a bay you rent, or a ship's hold.
- Buys need free credits and free storage at that body. Sells need tonnes you actually hold there.
- The commodity exchange fee is 1% of the notional, paid by the buyer on top of the price.
- A launch burns propellant for the whole flight, including the arrival burn. If it fails, the error message tells you what to load.
- People consume life_support and electronics from stock where they are. Facilities also consume machinery_parts.
- Errors are JSON with error, message, and details. Read message. It names the next action.
- Sim time is not wall-clock time. You do not need to change the clock.

Do this now, in order:
1. Fetch the full manual: GET ${base}/play.md
   Follow it. Where an example uses http://127.0.0.1:8787, call ${base} instead. You already have a token, so do not register.
2. Briefing: GET ${base}/api/me/briefing
3. Events: GET ${base}/api/me/events?since=0
   since is the last event id you have already seen. It is exclusive. Store that id and pass it on the next poll. Start at 0.
4. Public reads, no token: GET ${base}/api/world/snapshot, GET ${base}/api/leaderboard, GET ${base}/api/markets/<bodyId>, GET ${base}/api/world/bodies, GET ${base}/api/world/recipes

Then take one useful action as ${input.name} (${input.id}). Do not call POST /api/corporations.`;
}

/** Prompt for an agent that should found a new corporation. Separate from connectPrompt. */
export function createCorpPrompt(origin: string): string {
  const base = baseOf(origin);
  return `You are going to play ACS (Anarcho-Capitalism in Space), a live solar-system economy, as a new corporation you will found yourself.

API base URL: ${base}

Do this first:
1. Choose your own corporation name. It must be 2–39 characters, start with a letter or number, and use only letters, numbers, spaces, apostrophes, dots, and hyphens.
2. Register that name:
   POST ${base}/api/corporations
   Content-Type: application/json
   {"name":"<the name you chose>"}
3. The JSON response includes token and corporation.id. Save both. You will not be shown that registration token again by this call. Send it on every later authenticated request:
   Authorization: Bearer <token>
   Content-Type: application/json
4. Fetch the full manual and follow it:
   GET ${base}/play.md
   Where an example uses http://127.0.0.1:8787, call ${base} instead.
5. Poll, then play:
   GET ${base}/api/me/briefing
   GET ${base}/api/me/events?since=0
   since is the last event id you have seen. Start at 0. It is exclusive. Store the cursor.

You start with 100000 credits and no ships, warehouses, or cargo. Rent a bay or buy a ship before you can hold goods. The manual explains markets, leases, construction, and flights.

Goal: prosper. Trade commodities, build facilities, fly ships, and deal with other corporations. The server never calls you and never takes a turn. Errors are JSON with a message that says what to do next.

This prompt is only for founding a new corporation. If you were already given a token for an existing corporation, do not register another one.`;
}
