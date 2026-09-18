/**
 * bitrate-advisor: live-stream encoder settings from telemetry, using TypeSafe's
 * Jev decision model over OpenRouter, wrapped in deterministic guardrails.
 * Runs unchanged in Deno and Node 20+ (ESM, no dependencies).
 */

/** One rung of the bitrate ladder. */
export type Rung = { kbps: number; label: string };

/** Default bitrate ladder. */
export const DEFAULT_LADDER: Rung[] = [
  { kbps: 800, label: "480p-class" },
  { kbps: 1200, label: "540p-class" },
  { kbps: 2000, label: "720p-class" },
  { kbps: 3000, label: "720p60-class" },
  { kbps: 4500, label: "1080p-class" },
  { kbps: 6000, label: "1080p-high-class" },
  { kbps: 8000, label: "1080p-max-class" },
];

/** What the client measures right now. */
export type Telemetry = {
  platform: string;
  deviceModel?: string;
  appVersion?: string;
  batteryPct?: number;
  charging?: boolean;
  /** Measured battery drain while streaming, percent per minute (positive = draining). */
  batteryDrainPctPerMin?: number;
  /** Minutes of game left to stream; unlocks the power plan. */
  minutesRemaining?: number;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical";
  networkType?: "wifi" | "cellular" | "ethernet" | "unknown";
  carrierAsn?: string;
  venueId?: string;
  uplinkProbeKbps?: number;
  rttMs?: number;
  jitterMs?: number;
  packetLossPct?: number;
  encoderKbps?: number;
  currentRungKbps?: number;
  droppedFramesPct?: number;
  sendQueueMs?: number;
  secondsLive: number;
  recentActions?: string[];
};

/** Priors from earlier sessions, all optional. */
export type History = {
  sessions: number;
  sustainedUplinkKbpsP50?: number;
  sustainedUplinkKbpsP10?: number;
  stallRateByRung?: Record<string, number>;
  thermalThrottleRate1080p60?: number;
  scope: "venue+asn" | "asn" | "device" | "global" | "none";
};

/** The advice produced for the encoder. */
export type Advice = {
  mode: "start" | "tick";
  initialKbps: number;
  minKbps: number;
  maxKbps: number;
  resolution: "720p30" | "1080p30" | "1080p60";
  nextStep: "DOWN_1" | "HOLD" | "UP_1";
  targetKbps: number;
  source: "jev" | "policy";
  guardrails: string[];
  probabilities?: Record<string, Record<string, number>>;
  confidence?: Record<string, number>;
  costUsd?: number;
  latencyMs: number;
  state: object;
};

/** Options for the advisor. */
export type AdvisorOptions = {
  apiKey?: string;
  url?: string;
  model?: string;
  ladder?: Rung[];
  /** Never target above uplinkProbe * headroom. Default 0.7. */
  headroom?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** A summary of one past streaming session. */
export type SessionSummary = {
  venueId?: string;
  carrierAsn?: string;
  deviceModel?: string;
  sustainedUplinkKbps: number;
  stalledAtOrAboveKbps?: number | null;
  usedResolution?: string;
  thermalThrottled?: boolean;
};

/** Raised when Jev returns an invalid or unusable answer. */
import { applyPowerPlan, morePowerConservative, powerQuestion, projectPower, type PowerPlan, type AdviceWithPower } from "./power.ts";

export class JevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevError";
  }
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Nearest-rank percentile of a numeric array. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

/** Build a compact, readable state object to send to Jev. */
export function buildState(t: Telemetry, h: History): object {
  const session = omitUndefined({
    platform: t.platform,
    deviceModel: t.deviceModel,
    appVersion: t.appVersion,
    batteryPct: t.batteryPct,
    lowPowerMode: t.lowPowerMode,
    thermalState: t.thermalState,
    networkType: t.networkType,
    carrierAsn: t.carrierAsn,
    venueId: t.venueId,
  });
  const measured = omitUndefined({
    uplinkProbeKbps: t.uplinkProbeKbps,
    rttMs: t.rttMs,
    jitterMs: t.jitterMs,
    packetLossPct: t.packetLossPct,
    encoderKbps: t.encoderKbps,
    currentRungKbps: t.currentRungKbps,
    droppedFramesPct: t.droppedFramesPct,
    sendQueueMs: t.sendQueueMs,
    secondsLive: t.secondsLive,
  });
  const history = omitUndefined({
    sessions: h.sessions,
    sustainedUplinkKbpsP50: h.sustainedUplinkKbpsP50,
    sustainedUplinkKbpsP10: h.sustainedUplinkKbpsP10,
    stallRateByRung: h.stallRateByRung,
    thermalThrottleRate1080p60: h.thermalThrottleRate1080p60,
    scope: h.scope,
  });
  return {
    session,
    measured_now: measured,
    history,
    recent_actions: (t.recentActions ?? []).slice(-6),
    ...(t.minutesRemaining !== undefined && { game: { minutes_remaining: t.minutesRemaining } }),
  };
}

/** Build the Jev questions for a start or tick decision. */
export function buildQuestions(
  mode: "start" | "tick",
  ladder: Rung[],
  t: Telemetry
): Record<string, unknown> {
  const goal = {
    goal:
      "Never stall in the first minute. Prefer the highest bitrate rung the measured AND historical uplink sustains with headroom. Step down on rising dropped frames, send queue growth or packet loss. Step up only after a clean stretch. Lower resolution/fps when thermal state is serious or battery is low.",
  };
  const rungCriteria: Record<string, string> = {};
  for (const r of ladder) rungCriteria[String(r.kbps)] = r.label;
  const q: Record<string, unknown> = {};
  if (mode === "start") {
    q["initial_bitrate_kbps"] = {
      type: "choice",
      criteria: rungCriteria,
      instructions: {
        ...goal,
        meaning:
          "Choose the starting encoder bitrate in kbps from the ladder rungs.",
      },
    };
    q["ceiling_kbps"] = {
      type: "choice",
      criteria: rungCriteria,
      instructions: {
        ...goal,
        meaning:
          "Choose the maximum the auto-bitrate may climb to during this stream.",
      },
    };
  } else {
    q["next_step"] = {
      type: "choice",
      criteria: {
        DOWN_1: "drop one rung on the ladder",
        HOLD: "stay on the current rung",
        UP_1: "climb one rung after a clean stretch",
      },
      instructions: {
        ...goal,
        meaning: "Choose the next bitrate step relative to the current rung.",
      },
    };
  }
  q["resolution"] = {
    type: "choice",
    criteria: {
      "720p30": "1280x720 at 30 fps, safest for weak links",
      "1080p30": "1920x1080 at 30 fps, for solid uplink",
      "1080p60": "1920x1080 at 60 fps, needs headroom and cool battery",
    },
    instructions: {
      ...goal,
      meaning: "Choose the output resolution and frame rate.",
    },
  };
  if (t.batteryPct !== undefined && t.minutesRemaining !== undefined) {
    q.power_plan = powerQuestion({
      batteryPct: t.batteryPct, charging: t.charging, lowPowerMode: t.lowPowerMode,
      drainPctPerMin: t.batteryDrainPctPerMin, minutesRemaining: t.minutesRemaining, thermalState: t.thermalState,
    });
  }
  return q;
}

function effectiveHeadroom(opts?: { headroom?: number }): number {
  return typeof opts?.headroom === "number" && opts.headroom > 0
    ? opts.headroom
    : 0.7;
}

function rungAtOrBelow(kbps: number, ladder: Rung[]): Rung {
  let best = ladder[0];
  for (const r of ladder) if (r.kbps <= kbps) best = r;
  return best;
}

/** The deterministic fallback advice. */
export function policyAdvice(
  mode: "start" | "tick",
  t: Telemetry,
  h: History,
  ladder: Rung[],
  headroom: number
): Advice {
  const guards: string[] = [];
  const caps: number[] = [];
  if (t.uplinkProbeKbps !== undefined)
    caps.push(t.uplinkProbeKbps * headroom);
  if (h.sustainedUplinkKbpsP10 !== undefined)
    caps.push(h.sustainedUplinkKbpsP10 * 1.1);
  // Nothing measured and no history: 3000 kbps is the blind default.
  const cap = caps.length > 0 ? Math.min(...caps) : 3000;

  const initial =
    mode === "start"
      ? rungAtOrBelow(cap, ladder)
      : rungAtOrBelow(t.currentRungKbps ?? ladder[0].kbps, ladder);

  const ceilingCaps: number[] = [8000];
  if (t.uplinkProbeKbps !== undefined)
    ceilingCaps.push(t.uplinkProbeKbps * headroom);
  if (h.sustainedUplinkKbpsP50 !== undefined)
    ceilingCaps.push(h.sustainedUplinkKbpsP50);
  const ceilingKbps = Math.min(...ceilingCaps);
  const ceiling = rungAtOrBelow(ceilingKbps, ladder);

  let nextStep: Advice["nextStep"] = "HOLD";
  let target = initial;
  if (mode === "tick") {
    const loss = t.packetLossPct ?? 0;
    const queue = t.sendQueueMs ?? 0;
    const dropped = t.droppedFramesPct ?? 0;
    if (loss > 2 || queue > 1000 || dropped > 3) nextStep = "DOWN_1";
    else if (
      t.secondsLive >= 60 &&
      loss < 0.5 &&
      queue < 200 &&
      dropped < 0.5 &&
      initial.kbps < ceiling.kbps
    )
      nextStep = "UP_1";
    const idx = ladder.findIndex((r) => r.kbps === initial.kbps);
    const nextIdx =
      nextStep === "DOWN_1"
        ? Math.max(0, idx - 1)
        : nextStep === "UP_1"
        ? Math.min(ladder.length - 1, idx + 1)
        : idx;
    target = ladder[nextIdx];
  }

  const throttleRate = h.thermalThrottleRate1080p60 ?? 0;
  let resolution: Advice["resolution"];
  if (
    target.kbps >= 4500 &&
    t.thermalState === "nominal" &&
    (t.batteryPct ?? 100) >= 30 &&
    throttleRate < 0.2
  )
    resolution = "1080p60";
  else if (target.kbps >= 3000) resolution = "1080p30";
  else resolution = "720p30";

  return {
    mode,
    initialKbps: initial.kbps,
    minKbps: mode === "start" ? ladder[0].kbps : initial.kbps,
    maxKbps: ceiling.kbps,
    resolution,
    nextStep,
    targetKbps: target.kbps,
    source: "policy",
    guardrails: guards,
    latencyMs: 0,
    state: {},
  };
}

const STEP_ORDER: Advice["nextStep"][] = ["DOWN_1", "HOLD", "UP_1"];
const RES_ORDER: Advice["resolution"][] = ["720p30", "1080p30", "1080p60"];

function rungBelow(kbps: number, ladder: Rung[]): number {
  const idx = ladder.findIndex((r) => r.kbps === kbps);
  return idx > 0 ? ladder[idx - 1].kbps : ladder[0].kbps;
}

/**
 * Reconcile a Jev answer with the deterministic policy: the policy is the safety envelope and
 * Jev may only be equal to it or more conservative. Jev earns its keep by stepping down early
 * (it sees the history, the ASN, the thermal trend); it can never out-bid what the network
 * measured. Every clamp is written into `guardrails` in words.
 */
export function applyGuardrails(
  advice: Advice,
  t: Telemetry,
  h: History,
  ladder: Rung[],
  headroom: number
): Advice {
  const policy = policyAdvice(advice.mode, t, h, ladder, headroom);
  const guards = [...advice.guardrails];

  let initialKbps = advice.initialKbps;
  if (advice.mode === "start" && initialKbps > policy.initialKbps) {
    guards.push(
      `initial ${initialKbps} kbps is above the measured envelope; policy allows ${policy.initialKbps} kbps`
    );
    initialKbps = policy.initialKbps;
  }

  let maxKbps = advice.maxKbps;
  if (advice.mode === "start") {
    maxKbps = Math.min(advice.maxKbps, policy.maxKbps);
    if (maxKbps < advice.maxKbps) {
      guards.push(`ceiling ${advice.maxKbps} kbps lowered to ${maxKbps} kbps (probe and history)`);
    }
    if (maxKbps < initialKbps) maxKbps = initialKbps;
  }

  let nextStep = advice.nextStep;
  if (advice.mode === "tick") {
    const jevRank = STEP_ORDER.indexOf(nextStep);
    const policyRank = STEP_ORDER.indexOf(policy.nextStep);
    if (jevRank > policyRank) {
      guards.push(
        `${nextStep} overruled: loss ${t.packetLossPct ?? 0}%, queue ${t.sendQueueMs ?? 0} ms, dropped ${t.droppedFramesPct ?? 0}%, live ${t.secondsLive}s allow at most ${policy.nextStep}`
      );
      nextStep = policy.nextStep;
    }
  }

  let targetKbps = advice.mode === "start" ? initialKbps : advice.targetKbps;
  if (advice.mode === "tick") {
    const base = t.currentRungKbps ?? ladder[0].kbps;
    const idx = Math.max(0, ladder.findIndex((r) => r.kbps === base));
    const nextIdx =
      nextStep === "DOWN_1" ? Math.max(0, idx - 1) : nextStep === "UP_1" ? Math.min(ladder.length - 1, idx + 1) : idx;
    targetKbps = ladder[nextIdx].kbps;
    if (targetKbps > policy.maxKbps && nextStep !== "DOWN_1") {
      guards.push(`target ${targetKbps} kbps is above the ceiling ${policy.maxKbps} kbps; stepping down instead`);
      nextStep = "DOWN_1";
      targetKbps = ladder[Math.max(0, idx - 1)].kbps;
    }
  }

  let resolution = advice.resolution;
  if (RES_ORDER.indexOf(resolution) > RES_ORDER.indexOf(policy.resolution)) {
    guards.push(
      `${resolution} lowered to ${policy.resolution} (target ${targetKbps} kbps, thermal ${t.thermalState ?? "unknown"}, battery ${t.batteryPct ?? "unknown"}%)`
    );
    resolution = policy.resolution;
  }

  if (advice.mode === "tick") {
    // While live the envelope is the running session's; report the ceiling the policy would
    // allow from here, never below the rung we are stepping to.
    maxKbps = Math.max(policy.maxKbps, targetKbps);
  }
  const minKbps = advice.mode === "start" ? rungBelow(initialKbps, ladder) : ladder[0].kbps;
  return { ...advice, initialKbps, minKbps, maxKbps, resolution, nextStep, targetKbps, guardrails: guards };
}

type JevResponse = {
  answers: Record<
    string,
    {
      type: string;
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  >;
  usage: { input_tokens: number; output_tokens: number; cost: number };
};

function readEnvKey(): string | undefined {
  const p = (globalThis as Record<string, unknown>).process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  if (p?.env?.OPENROUTER_API_KEY) return p.env.OPENROUTER_API_KEY;
  const d = (globalThis as Record<string, unknown>).Deno as
    | { env?: { get: (k: string) => string | undefined } }
    | undefined;
  try {
    return d?.env?.get("OPENROUTER_API_KEY");
  } catch {
    return undefined;
  }
}

/** Call the Jev decision API with retries on 429/5xx/network errors. */
export async function askJev(
  state: object,
  questions: Record<string, unknown>,
  opts: AdvisorOptions
): Promise<{ answers: JevResponse["answers"]; usage: JevResponse["usage"] }> {
  const url = opts.url ?? "https://openrouter.ai/api/alpha/decisions";
  const model = opts.model ?? "typesafe/jev-1.13";
  const f = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new JevError("missing api key");

  const backoff = [300, 600, 1200];
  const sleep = (ms: number) =>
    new Promise<void>((r) => setTimeout(r, ms));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, state, questions }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new JevError(`retryable status ${res.status}`);
        if (attempt < 3) {
          await sleep(backoff[attempt]);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new JevError(`jev returned status ${res.status}`);
      const json = (await res.json()) as JevResponse;
      for (const [name, spec] of Object.entries(questions as Record<string, { criteria: Record<string, unknown> }>)) {
        const ans = json.answers?.[name];
        if (!ans || typeof ans.choice !== "string" || !(ans.choice in spec.criteria)) {
          throw new JevError(`missing or invalid answer for question "${name}"`);
        }
        if (!ans.probabilities || typeof ans.probabilities !== "object") {
          throw new JevError(`invalid probabilities for question "${name}"`);
        }
      }
      return { answers: json.answers, usage: json.usage };
    } catch (e) {
      if (e instanceof JevError && !String(e.message).includes("retryable")) throw e;
      lastErr = e;
      if (attempt < 3) {
        await sleep(backoff[attempt]);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new JevError("jev failed");
}

/** Produce encoder advice: Jev if an API key exists, policy otherwise. */
export async function advise(
  mode: "start" | "tick",
  t: Telemetry,
  h: History,
  opts: AdvisorOptions = {}
): Promise<Advice> {
  const ladder = opts.ladder ?? DEFAULT_LADDER;
  const headroom = effectiveHeadroom(opts);
  const now = opts.now ?? Date.now;
  const started = now();
  const apiKey = opts.apiKey ?? readEnvKey();

  if (!apiKey) {
    const base = policyAdvice(mode, t, h, ladder, headroom);
    base.guardrails.push("no api key: policy only");
    base.latencyMs = now() - started;
    base.state = buildState(t, h);
    return withPowerPlan(base, t);
  }

  const state = buildState(t, h);
  const questions = buildQuestions(mode, ladder, t);
  try {
    const { answers, usage } = await askJev(state, questions, { ...opts, apiKey });
    const latencyMs = now() - started;
    const probabilities: Record<string, Record<string, number>> = {};
    const confidence: Record<string, number> = {};
    for (const [k, v] of Object.entries(answers)) {
      probabilities[k] = v.probabilities;
      confidence[k] = v.confidence;
    }

    let initialKbps: number;
    let maxKbps: number;
    let nextStep: Advice["nextStep"];
    let targetKbps: number;
    let minKbps: number;

    if (mode === "start") {
      initialKbps = Number(answers["initial_bitrate_kbps"].choice);
      maxKbps = Number(answers["ceiling_kbps"].choice);
      if (maxKbps < initialKbps) maxKbps = initialKbps;
      const idx = ladder.findIndex((r) => r.kbps === initialKbps);
      minKbps = idx > 0 ? ladder[idx - 1].kbps : ladder[0].kbps;
      targetKbps = initialKbps;
      nextStep = "HOLD";
    } else {
      nextStep = answers["next_step"].choice as Advice["nextStep"];
      const baseKbps = t.currentRungKbps ?? ladder[0].kbps;
      const idx = Math.max(0, ladder.findIndex((r) => r.kbps === baseKbps));
      const nextIdx =
        nextStep === "DOWN_1"
          ? Math.max(0, idx - 1)
          : nextStep === "UP_1"
          ? Math.min(ladder.length - 1, idx + 1)
          : idx;
      targetKbps = ladder[nextIdx].kbps;
      initialKbps = baseKbps;
      minKbps = ladder[0].kbps;
      maxKbps = baseKbps;
    }

    const advice: Advice = {
      mode,
      initialKbps,
      minKbps,
      maxKbps,
      resolution: answers["resolution"].choice as Advice["resolution"],
      nextStep,
      targetKbps,
      source: "jev",
      guardrails: [],
      probabilities,
      confidence,
      costUsd: usage.cost,
      latencyMs,
      state,
    };
    const guarded = applyGuardrails(advice, t, h, ladder, headroom);
    return withPowerPlan(guarded, t, answers["power_plan"]?.choice);
  } catch (e) {
    const base = policyAdvice(mode, t, h, ladder, headroom);
    base.guardrails.push(
      `jev failed: ${e instanceof Error ? e.message : String(e)}`
    );
    base.latencyMs = now() - started;
    base.state = state;
    return withPowerPlan(base, t);
  }
}

/** Battery and thermal plan: the deterministic projection, made more conservative by Jev's
 * `power_plan` answer when one came back, never less. No-op without battery and game-clock data. */
export function withPowerPlan(advice: Advice, t: Telemetry, jevPlan?: string): AdviceWithPower {
  if (t.batteryPct === undefined || t.minutesRemaining === undefined) return advice;
  const projection = projectPower({
    batteryPct: t.batteryPct, charging: t.charging, lowPowerMode: t.lowPowerMode,
    drainPctPerMin: t.batteryDrainPctPerMin, minutesRemaining: t.minutesRemaining,
    thermalState: t.thermalState, resolution: advice.resolution,
  });
  let plan: PowerPlan = projection.plan;
  let reason = projection.reason;
  const order: PowerPlan[] = ["FULL", "SAVE_FPS", "SAVE_RES", "SAVE_MAX", "PLUG_IN"];
  if (jevPlan && (order as string[]).includes(jevPlan)) {
    // Jev may tighten the plan by ONE step over the projection (it sees the whole state), but
    // PLUG_IN is a message to a human and is only allowed when the projection itself says the
    // battery will not finish the game.
    const merged = morePowerConservative(plan, jevPlan as PowerPlan);
    const capped = order[Math.min(order.indexOf(merged), order.indexOf(plan) + 1)];
    const final = capped === "PLUG_IN" && projection.willFinish ? "SAVE_MAX" : capped;
    if (final !== plan) reason = `Jev tightened ${plan} to ${final} (${reason})`;
    plan = final;
  }
  return applyPowerPlan(advice, plan, reason, projection);
}

/** Aggregate past session summaries into a History prior. */
export function aggregateHistory(
  sessions: SessionSummary[],
  key: { venueId?: string; carrierAsn?: string; deviceModel?: string }
): History {
  const none: History = { sessions: 0, scope: "none" };
  if (sessions.length === 0) return none;

  const matches = (s: SessionSummary, want: Partial<SessionSummary>) =>
    Object.entries(want).every(
      ([k, v]) => v === undefined || (s as Record<string, unknown>)[k] === v
    );

  const scopes: Array<{
    scope: History["scope"];
    filter: (s: SessionSummary) => boolean;
  }> = [
    {
      scope: "venue+asn",
      filter: (s) =>
        key.venueId !== undefined &&
        key.carrierAsn !== undefined &&
        s.venueId === key.venueId &&
        s.carrierAsn === key.carrierAsn,
    },
    {
      scope: "asn",
      filter: (s) =>
        key.carrierAsn !== undefined && s.carrierAsn === key.carrierAsn,
    },
    {
      scope: "device",
      filter: (s) =>
        key.deviceModel !== undefined && s.deviceModel === key.deviceModel,
    },
    { scope: "global", filter: () => true },
  ];

  let picked: SessionSummary[] | null = null;
  let scope: History["scope"] = "none";
  for (const sc of scopes) {
    const m = sessions.filter(sc.filter);
    if (m.length >= 3) {
      picked = m;
      scope = sc.scope;
      break;
    }
  }
  if (!picked) return none;

  const uplinks = picked.map((s) => s.sustainedUplinkKbps);
  const p50 = percentile(uplinks, 50);
  const p10 = percentile(uplinks, 10);

  const stallRateByRung: Record<string, number> = {};
  for (const r of DEFAULT_LADDER) {
    const eligible = picked.filter((s) => s.stalledAtOrAboveKbps != null);
    // a session that stalled once it ran at X kbps is evidence against every rung >= X;
    // the rate is over ALL sessions in scope (a clean session is evidence for the rung)
    const stalled = eligible.filter(
      (s) => (s.stalledAtOrAboveKbps as number) <= r.kbps
    ).length;
    stallRateByRung[String(r.kbps)] = stalled / picked.length;
  }

  const hd60 = picked.filter((s) => s.usedResolution === "1080p60");
  const throttleRate =
    hd60.length > 0
      ? hd60.filter((s) => s.thermalThrottled).length / hd60.length
      : 0;

  return {
    sessions: picked.length,
    sustainedUplinkKbpsP50: p50,
    sustainedUplinkKbpsP10: p10,
    stallRateByRung,
    thermalThrottleRate1080p60: throttleRate,
    scope,
  };
}
