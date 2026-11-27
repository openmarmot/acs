import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./http.js";

const dbPath = process.env.ACS_DB ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/acs.db");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const ctx = await createApp({ dbPath, tick: true });
await ctx.app.listen({ port, host });
console.log(`ACS listening on http://${host}:${port}`);
console.log(`Playbook: http://${host}:${port}/play.md`);
console.log(`Database: ${dbPath}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await ctx.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
