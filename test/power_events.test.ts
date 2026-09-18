import { assertEquals, assert } from "jsr:@std/assert";
import { projectPower, applyPowerPlan, morePowerConservative, drainRatePctPerMin } from "../src/power.ts";
import { EventAdvisor, URGENT } from "../src/events.ts";
import { withPowerPlan, type Advice, type Telemetry } from "../src/advisor.ts";

const base: Advice = {
  mode: "start", initialKbps: 4500, minKbps: 3000, maxKbps: 6000, resolution: "1080p60", nextStep: "HOLD",
  targetKbps: 4500, source: "policy", guardrails: [], latencyMs: 0, state: {},
};

Deno.test("charging phone keeps everything", () => {
  const p = projectPower({ batteryPct: 40, charging: true, minutesRemaining: 90, resolution: "1080p60" });
  assertEquals(p.plan, "FULL");
  assertEquals(p.willFinish, true);
});

Deno.test("measured drain decides the plan", () => {
  // 35% left, 1.2 %/min -> 25 min to the 5% reserve; 60 min of game left -> deficit
  const p = projectPower({ batteryPct: 35, drainPctPerMin: 1.2, minutesRemaining: 60, resolution: "1080p60" });
  assert(p.plan === "SAVE_MAX" || p.plan === "PLUG_IN", p.plan);
  // 80% left, 0.7 %/min -> 107 min; 60 left -> 47 min margin -> FULL
  assertEquals(projectPower({ batteryPct: 80, drainPctPerMin: 0.7, minutesRemaining: 60, resolution: "1080p30" }).plan, "FULL");
  // 5 <= margin < 15 at 60 fps -> SAVE_FPS
  assertEquals(projectPower({ batteryPct: 50, drainPctPerMin: 0.8, minutesRemaining: 48, resolution: "1080p60" }).plan, "SAVE_FPS");
});

Deno.test("thermal and low power only make the plan more conservative", () => {
  assertEquals(projectPower({ batteryPct: 95, drainPctPerMin: 0.5, minutesRemaining: 30, thermalState: "serious", resolution: "1080p60" }).plan, "SAVE_RES");
  assertEquals(projectPower({ batteryPct: 95, drainPctPerMin: 0.5, minutesRemaining: 30, thermalState: "critical", resolution: "1080p60" }).plan, "SAVE_MAX");
  assertEquals(projectPower({ batteryPct: 95, drainPctPerMin: 0.5, minutesRemaining: 30, lowPowerMode: true, resolution: "1080p60" }).plan, "SAVE_FPS");
  assertEquals(morePowerConservative("SAVE_FPS", "PLUG_IN"), "PLUG_IN");
});

Deno.test("applyPowerPlan lowers settings and explains itself", () => {
  const a = applyPowerPlan(base, "SAVE_MAX", "deficit 20 min");
  assertEquals(a.resolution, "720p30");
  assertEquals(a.maxKbps, 2000);
  assertEquals(a.targetKbps, 2000);
  assert(a.guardrails[a.guardrails.length - 1].startsWith("power plan SAVE_MAX"));
  const full = applyPowerPlan(base, "FULL", "47 min of margin");
  assertEquals(full.guardrails.length, 0);
  assertEquals(full.power?.plan, "FULL");
});

Deno.test("withPowerPlan: Jev may only be more conservative than the projection", () => {
  const t: Telemetry = { platform: "iOS", batteryPct: 80, batteryDrainPctPerMin: 0.7, minutesRemaining: 60, secondsLive: 0 };
  assertEquals(withPowerPlan(base, t, "FULL").power?.plan, "FULL");
  assertEquals(withPowerPlan(base, t, "SAVE_RES").power?.plan, "SAVE_RES");
  const tight: Telemetry = { ...t, batteryPct: 30, batteryDrainPctPerMin: 1.5 };
  const p = withPowerPlan(base, tight, "FULL").power?.plan;
  assert(p === "SAVE_MAX" || p === "PLUG_IN", String(p));
  assertEquals(withPowerPlan(base, { platform: "iOS", secondsLive: 0 }).power, undefined);
});

Deno.test("drain rate needs three minutes of discharging samples", () => {
  const t0 = 1_000_000;
  assertEquals(drainRatePctPerMin([{ pct: 80, charging: false, atMs: t0 }, { pct: 79, charging: false, atMs: t0 + 60_000 }]), undefined);
  const r = drainRatePctPerMin([{ pct: 80, charging: false, atMs: t0 }, { pct: 76, charging: false, atMs: t0 + 5 * 60_000 }]);
  assertEquals(r, 0.8);
});

Deno.test("events: urgent ones react at once, others are debounced, deltas are derived", async () => {
  let clock = 0;
  const calls: string[] = [];
  const fakeFetch = ((_u: unknown, init: RequestInit) => {
    calls.push(String(init.body).slice(0, 20));
    return Promise.resolve(new Response(JSON.stringify({
      answers: { operation: { type: "choice", choice: "HOLD", probabilities: { HOLD: 1 } } },
      usage: { cost: 0 },
    }), { status: 200 }));
  }) as unknown as typeof fetch;
  const ev = new EventAdvisor({ apiKey: "", fetchImpl: fakeFetch }, { debounceMs: 3000, minTickGapMs: 5000, now: () => clock });
  const t: Telemetry = { platform: "iOS", currentRungKbps: 3000, secondsLive: 100 };
  const h = { sessions: 0, scope: "none" as const };
  assert(URGENT.has("disconnect"));
  const a1 = await ev.onEvent({ type: "period_break", atMs: 0 }, t, h);
  assert(a1 !== null);
  clock = 1000;
  assertEquals(await ev.onEvent({ type: "period_break", atMs: 1000 }, t, h), null); // debounced
  assert((await ev.onEvent({ type: "disconnect", atMs: 1000 }, t, h)) !== null); // urgent
  assertEquals(await ev.onTick(t, h), null); // inside the tick gap
  clock = 7000;
  assert((await ev.onTick(t, h)) !== null);
  const derived = EventAdvisor.eventsFromDelta(
    { platform: "iOS", secondsLive: 0, thermalState: "nominal", batteryPct: 25, droppedFramesPct: 1, sendQueueMs: 100, encoderKbps: 3000 },
    { platform: "iOS", secondsLive: 10, thermalState: "serious", batteryPct: 18, droppedFramesPct: 5, sendQueueMs: 1500, encoderKbps: 2000 },
    5000,
  ).map((e) => e.type);
  for (const want of ["thermal_change", "battery_low", "dropped_frames_spike", "send_queue_growing", "bitrate_stepdown"]) assert(derived.includes(want as never), want);
});
