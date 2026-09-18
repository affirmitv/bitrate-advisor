import { assertEquals, assert, assertRejects } from "jsr:@std/assert";
import {
  aggregateHistory,
  advise,
  applyGuardrails,
  buildQuestions,
  buildState,
  DEFAULT_LADDER,
  JevError,
  percentile,
  policyAdvice,
  type Advice,
  type History,
  type SessionSummary,
  type Telemetry,
  askJev,
} from "../src/advisor.ts";

const WEAK_TELEMETRY: Telemetry = {
  platform: "ios",
  venueId: "v1",
  carrierAsn: "AS123",
  uplinkProbeKbps: 4200,
  thermalState: "fair",
  batteryPct: 35,
  secondsLive: 0,
};

const STRONG_HISTORY: History = {
  sessions: 7,
  scope: "venue+asn",
  sustainedUplinkKbpsP50: 3100,
  sustainedUplinkKbpsP10: 1900,
};

function session(s: Partial<SessionSummary> = {}): SessionSummary {
  return {
    venueId: "v1",
    carrierAsn: "AS123",
    sustainedUplinkKbps: 3000,
    ...s,
  };
}

const UP7 = [1900, 2400, 2800, 3100, 3300, 3600, 4100];
function sessions7(): SessionSummary[] {
  return UP7.map((kbps) => session({ sustainedUplinkKbps: kbps }));
}

function jevBody(answers: Record<string, string>, cost = 0.001) {
  const wrapped = Object.fromEntries(
    Object.entries(answers).map(([k, choice]) => [
      k,
      { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 },
    ])
  );
  return {
    answers: wrapped,
    usage: { input_tokens: 10, output_tokens: 10, cost },
  };
}

function okFetch(body: unknown, status = 200): typeof fetch {
  return ((() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown) as typeof fetch;
}

Deno.test("percentile nearest-rank p50 and p10", () => {
  assertEquals(percentile(UP7, 50), 3100);
  assertEquals(percentile(UP7, 10), 1900);
});

Deno.test("aggregateHistory scope, percentiles, stall rates", () => {
  const withStalls = sessions7().map((s, i) =>
    i < 3 ? { ...s, stalledAtOrAboveKbps: 3500 } : s
  );
  const h = aggregateHistory(withStalls, { venueId: "v1", carrierAsn: "AS123" });
  assertEquals(h.scope, "venue+asn");
  assertEquals(h.sessions, 7);
  assertEquals(h.sustainedUplinkKbpsP50, 3100);
  assertEquals(h.sustainedUplinkKbpsP10, 1900);
  assert(h.stallRateByRung);
  assertEquals(h.stallRateByRung["4500"], 3 / 7);
  assertEquals(h.stallRateByRung["3000"], 0);

  const asnOnly = [
    ...sessions7().slice(0, 2),
    ...sessions7().slice(0, 5).map((s) => ({ ...s, venueId: "v2" })),
  ];
  assertEquals(aggregateHistory(asnOnly, { venueId: "v1", carrierAsn: "AS123" }).scope, "asn");
  assertEquals(aggregateHistory([], { venueId: "v1" }), { sessions: 0, scope: "none" });
});

Deno.test("policyAdvice start: weak link clamps to 2000/720p30", () => {
  const a = policyAdvice("start", WEAK_TELEMETRY, STRONG_HISTORY, DEFAULT_LADDER, 0.7);
  assertEquals(a.initialKbps, 2000); // min(3000, 2940, 2090)
  assertEquals(a.resolution, "720p30");
  assertEquals(a.maxKbps, 2000); // highest rung <= min(2940, p50 3100)
});

Deno.test("policyAdvice start: strong link takes 8000 initial and ceiling", () => {
  const t: Telemetry = {
    platform: "ios",
    uplinkProbeKbps: 41000,
    thermalState: "nominal",
    batteryPct: 92,
    secondsLive: 0,
  };
  const h: History = { sessions: 5, scope: "global", sustainedUplinkKbpsP50: 24000, sustainedUplinkKbpsP10: 9000 };
  const a = policyAdvice("start", t, h, DEFAULT_LADDER, 0.7);
  assertEquals(a.initialKbps, 8000); // cap = min(28700, 9900) -> highest rung 8000
  assertEquals(a.maxKbps, 8000); // min(8000, 28700, 24000)
  assertEquals(a.resolution, "1080p60"); // target 8000 >= 4500, nominal, battery 92, throttle rate 0
});

Deno.test("policyAdvice tick: degraded metrics force DOWN_1", () => {
  const t: Telemetry = {
    platform: "ios",
    currentRungKbps: 3000,
    packetLossPct: 2.1,
    sendQueueMs: 1800,
    droppedFramesPct: 6.5,
    secondsLive: 120,
  };
  const a = policyAdvice("tick", t, { sessions: 0, scope: "none" }, DEFAULT_LADDER, 0.7);
  assertEquals(a.nextStep, "DOWN_1");
  assertEquals(a.targetKbps, 2000);
});

Deno.test("policyAdvice tick: clean stream climbs after 60s", () => {
  const t: Telemetry = {
    platform: "ios",
    currentRungKbps: 2000,
    packetLossPct: 0,
    sendQueueMs: 0,
    droppedFramesPct: 0,
    secondsLive: 120,
  };
  const h: History = { sessions: 3, scope: "global", sustainedUplinkKbpsP50: 3100 };
  const a = policyAdvice("tick", t, h, DEFAULT_LADDER, 0.7);
  assertEquals(a.nextStep, "UP_1");
  assertEquals(a.targetKbps, 3000);
  assertEquals(policyAdvice("tick", { ...t, secondsLive: 30 }, h, DEFAULT_LADDER, 0.7).nextStep, "HOLD");
});

Deno.test("applyGuardrails start: jev 4500 clamped to 2000 with three sentences", () => {
  const jev: Advice = {
    mode: "start",
    initialKbps: 4500,
    minKbps: 3000,
    maxKbps: 6000,
    resolution: "1080p60",
    nextStep: "HOLD",
    targetKbps: 4500,
    source: "jev",
    guardrails: [],
    latencyMs: 0,
    state: {},
  };
  const out = applyGuardrails(jev, WEAK_TELEMETRY, STRONG_HISTORY, DEFAULT_LADDER, 0.7);
  assertEquals(out.initialKbps, 2000);
  assertEquals(out.minKbps, 400);
  assertEquals(out.maxKbps, 2000);
  assertEquals(out.resolution, "720p30");
  assertEquals(out.guardrails.length, 3);
  assert(out.guardrails.some((g) => g.includes("initial 4500")));
});

Deno.test("applyGuardrails tick: overrules optimistic jev, keeps conservative jev", () => {
  const t: Telemetry = {
    platform: "ios",
    currentRungKbps: 3000,
    packetLossPct: 2.1,
    sendQueueMs: 1800,
    droppedFramesPct: 6.5,
    secondsLive: 120,
  };
  const hold: Advice = {
    mode: "tick",
    initialKbps: 3000,
    minKbps: 800,
    maxKbps: 3000,
    resolution: "1080p30",
    nextStep: "HOLD",
    targetKbps: 3000,
    source: "jev",
    guardrails: [],
    latencyMs: 0,
    state: {},
  };
  const out = applyGuardrails(hold, t, { sessions: 0, scope: "none" }, DEFAULT_LADDER, 0.7);
  assertEquals(out.nextStep, "DOWN_1");
  assertEquals(out.targetKbps, 2000);
  assert(out.guardrails.some((g) => g.includes("overruled")));

  const down = { ...hold, nextStep: "DOWN_1" as const, targetKbps: 2000 };
  const clean: Telemetry = { ...t, packetLossPct: 0, sendQueueMs: 0, droppedFramesPct: 0, secondsLive: 120 };
  const h: History = { sessions: 3, scope: "global", sustainedUplinkKbpsP50: 3100 };
  const kept = applyGuardrails(down, clean, h, DEFAULT_LADDER, 0.7);
  assertEquals(kept.nextStep, "DOWN_1");
  assertEquals(kept.guardrails.filter((g) => g.includes("overruled")).length, 0);
});

Deno.test("advise start: jev answer clamped by guardrails", async () => {
  const fetchImpl = okFetch(
    jevBody({ initial_bitrate_kbps: "3000", ceiling_kbps: "4500", resolution: "1080p30" }, 0.00005)
  );
  const a = await advise("start", WEAK_TELEMETRY, STRONG_HISTORY, { apiKey: "test", fetchImpl });
  assertEquals(a.source, "jev");
  assertEquals(a.costUsd, 0.00005);
  assert(a.probabilities);
  assertEquals(Object.keys(a.probabilities).sort(), ["ceiling_kbps", "initial_bitrate_kbps", "resolution"]);
  assertEquals(a.initialKbps, 2000);
  assertEquals(a.resolution, "720p30");
});

Deno.test("advise: falls back on 400, retries 503 then succeeds", async () => {
  const fail = await advise("start", WEAK_TELEMETRY, STRONG_HISTORY, {
    apiKey: "test",
    fetchImpl: okFetch({ error: "bad" }, 400),
  });
  assertEquals(fail.source, "policy");
  assert(fail.guardrails.some((g) => g.includes("jev failed")));

  let calls = 0;
  const retryFetch = ((() => {
    calls++;
    return Promise.resolve(calls === 1
      ? new Response("{}", { status: 503 })
      : new Response(
          JSON.stringify(jevBody({ initial_bitrate_kbps: "2000", ceiling_kbps: "3000", resolution: "720p30" })),
          { status: 200 }
        ));
  }) as unknown) as typeof fetch;
  const ok = await advise("start", WEAK_TELEMETRY, STRONG_HISTORY, { apiKey: "test", fetchImpl: retryFetch });
  assertEquals(calls, 2);
  assertEquals(ok.source, "jev");
});

Deno.test("advise without api key uses policy", async () => {
  const a = await advise("start", WEAK_TELEMETRY, STRONG_HISTORY, { apiKey: "" });
  assertEquals(a.source, "policy");
  assert(a.guardrails.includes("no api key: policy only"));
});

Deno.test("askJev rejects invalid answers", async () => {
  const questions = buildQuestions("start", DEFAULT_LADDER, WEAK_TELEMETRY);
  await assertRejects(
    () => askJev({}, questions, { apiKey: "test", fetchImpl: okFetch(jevBody({ initial_bitrate_kbps: "9999", ceiling_kbps: "3000", resolution: "720p30" })) }),
    JevError
  );
  await assertRejects(
    () => askJev({}, questions, { apiKey: "test", fetchImpl: okFetch({ usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }) }),
    JevError
  );
});

Deno.test("buildQuestions shapes", () => {
  const start = buildQuestions("start", DEFAULT_LADDER, WEAK_TELEMETRY);
  const rungKeys = DEFAULT_LADDER.map((r) => String(r.kbps)).sort();
  for (const q of ["initial_bitrate_kbps", "ceiling_kbps"]) {
    assertEquals(Object.keys((start[q] as { criteria: Record<string, string> }).criteria).sort(), rungKeys);
  }
  assertEquals(Object.keys((start.resolution as { criteria: Record<string, string> }).criteria).length, 3);
  const tick = buildQuestions("tick", DEFAULT_LADDER, WEAK_TELEMETRY);
  assertEquals(Object.keys((tick.next_step as { criteria: Record<string, string> }).criteria), ["DOWN_1", "HOLD", "UP_1"]);
  assert(!("initial_bitrate_kbps" in tick));
});

Deno.test("buildState omits undefined fields, keeps last 6 actions", () => {
  const t: Telemetry = { platform: "ios", secondsLive: 5, recentActions: ["a", "b", "c", "d", "e", "f", "g"] };
  const state = buildState(t, { sessions: 0, scope: "none" }) as { session: Record<string, unknown>; recent_actions: string[] };
  assert(!("battery" in state.session));
  assert(!("batteryPct" in state.session));
  assertEquals(state.recent_actions, ["b", "c", "d", "e", "f", "g"]);
});

Deno.test("policyAdvice below the ladder floor starts at the floor and says so", () => {
  const a = policyAdvice("start", { platform: "iOS", uplinkProbeKbps: 500, secondsLive: 0 }, { sessions: 0, scope: "none" }, DEFAULT_LADDER, 0.7);
  assertEquals(a.initialKbps, 400);
  assertEquals(a.resolution, "720p30");
  assert(a.guardrails.some((g) => g.includes("below the 400 kbps floor")), a.guardrails.join(" | "));
});

Deno.test("policyAdvice never returns a ceiling below the starting rung", () => {
  // three sessions around 1900 kbps: p10 * 1.1 = 2090 -> start 2000, p50 = 1900 -> ceiling rung 1200 unless fixed
  const h = { sessions: 3, sustainedUplinkKbpsP50: 1900, sustainedUplinkKbpsP10: 1900, scope: "venue+asn" as const };
  const a = policyAdvice("start", { platform: "iOS", uplinkProbeKbps: 4200, secondsLive: 0 }, h, DEFAULT_LADDER, 0.7);
  assert(a.minKbps <= a.initialKbps && a.initialKbps <= a.maxKbps, `${a.minKbps} <= ${a.initialKbps} <= ${a.maxKbps}`);
  assertEquals(a.initialKbps, 2000);
  assertEquals(a.maxKbps, 2000);
});

Deno.test("askJev: a stalled connection hits the deadline and advise falls back to the policy", async () => {
  const stall = ((_u: unknown, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  const t0 = Date.now();
  const a = await advise("start", { platform: "iOS", uplinkProbeKbps: 4200, secondsLive: 0 }, { sessions: 0, scope: "none" }, { apiKey: "test", fetchImpl: stall, timeoutMs: 100, totalBudgetMs: 350 });
  assertEquals(a.source, "policy");
  assert(a.guardrails.some((g) => g.startsWith("jev failed")));
  assert(Date.now() - t0 < 1500, "fell back within the total budget, not 4 attempts x timeout");
});
