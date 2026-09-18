#!/usr/bin/env -S deno run --allow-net --allow-env
// bitrate-advisor CLI: `deno task advise start sample.json` or `... tick sample.json`
// The JSON file holds {"telemetry": Telemetry, "history"?: History, "sessions"?: SessionSummary[]}.
import { advise, aggregateHistory, type History, type SessionSummary, type Telemetry } from "./src/advisor.ts";

const [mode, file] = Deno.args;
if ((mode !== "start" && mode !== "tick") || !file) {
  console.error("usage: cli.ts <start|tick> <input.json>");
  Deno.exit(2);
}
const input = JSON.parse(await Deno.readTextFile(file)) as {
  telemetry: Telemetry; history?: History; sessions?: SessionSummary[];
};
const t = input.telemetry;
const h: History = input.history ??
  (input.sessions
    ? aggregateHistory(input.sessions, { venueId: t.venueId, carrierAsn: t.carrierAsn, deviceModel: t.deviceModel })
    : { sessions: 0, scope: "none" });
const a = await advise(mode, t, h);
console.log(JSON.stringify(a, null, 2));
