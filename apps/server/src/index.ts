import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./http.js";

const dbPath = process.env.ACS_DB ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/acs.db");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const ctx = await createApp({ dbPath, tick: true });
await ctx.app.listen({ port, host });
const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
console.log(`ACS listening on http://${publicHost}:${port}`);
console.log(`Playbook: http://${publicHost}:${port}/play.md`);
const observer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist/index.html");
if (existsSync(observer)) console.log(`Observer: http://${publicHost}:${port}`);
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
