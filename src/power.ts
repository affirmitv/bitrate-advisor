// src/power.ts — battery and thermal planning for finishing a game while streaming.
import type { Advice } from "./advisor.ts";

/** Power plans, least to most conservative. */
export type PowerPlan = "FULL" | "SAVE_FPS" | "SAVE_RES" | "SAVE_MAX" | "PLUG_IN";

/** One-line meaning of each plan. */
export const POWER_PLANS: Record<PowerPlan, string> = {
  FULL: "keep the advised settings",
  SAVE_FPS: "1080p60 becomes 1080p30",
  SAVE_RES: "drop to 720p30",
  SAVE_MAX: "720p30 and cap the bitrate at 2000 kbps",
  PLUG_IN: "battery will not last the game even at the lowest settings; plug in or hand off",
};

const PLAN_ORDER: PowerPlan[] = ["FULL", "SAVE_FPS", "SAVE_RES", "SAVE_MAX", "PLUG_IN"];

/** The more conservative of two plans. */
export function morePowerConservative(a: PowerPlan, b: PowerPlan): PowerPlan {
  return PLAN_ORDER[Math.max(PLAN_ORDER.indexOf(a), PLAN_ORDER.indexOf(b))];
}

/** One battery reading. */
export type BatterySample = { pct: number; charging: boolean; atMs: number };

/** Drain rate %/min from oldest and newest discharging samples >= 3 min apart; undefined if unknown. */
export function drainRatePctPerMin(samples: BatterySample[]): number | undefined {
  const discharging = samples.filter((s) => !s.charging);
  if (discharging.length < 2) return undefined;
  const oldest = discharging.reduce((a, b) => (b.atMs < a.atMs ? b : a));
  const newest = discharging.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  const minutes = (newest.atMs - oldest.atMs) / 60000;
  if (minutes < 3) return undefined;
  return (oldest.pct - newest.pct) / minutes;
}

/** Projection of whether the battery lasts the remaining game. */
export type PowerProjection = {
  minutesToEmpty: number | null;
  minutesRemaining: number;
  willFinish: boolean;
  marginMin: number | null;
  plan: PowerPlan;
  reason: string;
};

/** Assumed drain rates (%/min) when no measurement is available. */
const ASSUMED_DRAIN: Record<Advice["resolution"], number> = {
  "1080p60": 1.1,
  "1080p30": 0.8,
  "720p30": 0.6,
};

/** Project battery survival and pick a power plan. Deterministic. */
export function projectPower(input: {
  batteryPct: number;
  charging?: boolean;
  lowPowerMode?: boolean;
  drainPctPerMin?: number;
  minutesRemaining: number;
  thermalState?: string;
  resolution: Advice["resolution"];
}): PowerProjection {
  // Charging settles the BATTERY question only. Thermal and Low Power Mode floors below still
  // apply: a plugged-in phone at thermal critical must not run 1080p60 (judge finding, PR #1426).
  const floors = (plan: PowerPlan, reason: string): PowerProjection & { plan: PowerPlan; reason: string } => {
    if (input.thermalState === "serious") { plan = morePowerConservative(plan, "SAVE_RES"); reason += "; thermal serious"; }
    if (input.thermalState === "critical") { plan = morePowerConservative(plan, "SAVE_MAX"); reason += "; thermal critical"; }
    if (input.lowPowerMode) { plan = morePowerConservative(plan, "SAVE_FPS"); reason += "; low power mode"; }
    return { minutesToEmpty: null, minutesRemaining: input.minutesRemaining, willFinish: true, marginMin: null, plan, reason };
  };
  if (input.charging) {
    return floors("FULL", "charging");
  }
  const measured = input.drainPctPerMin;
  const drain = measured ?? ASSUMED_DRAIN[input.resolution];
  const minutesToEmpty = Math.max(0, (input.batteryPct - 5) / drain);
  const marginMin = minutesToEmpty - input.minutesRemaining;
  const willFinish = marginMin >= 0;

  let plan: PowerPlan;
  let reason: string;
  if (marginMin >= 15) {
    plan = "FULL";
    reason = `${marginMin.toFixed(0)} min of margin`;
  } else if (marginMin >= 5) {
    if (input.resolution === "1080p60") {
      plan = "SAVE_FPS";
      reason = `${marginMin.toFixed(0)} min margin; drop 60 fps`;
    } else {
      plan = "FULL";
      reason = `${marginMin.toFixed(0)} min of margin at 30 fps`;
    }
  } else if (marginMin >= 0) {
    plan = "SAVE_RES";
    reason = `only ${marginMin.toFixed(0)} min of margin`;
  } else {
    const rescue = (input.batteryPct - 5) / ASSUMED_DRAIN["720p30"];
    if (rescue >= input.minutesRemaining) {
      plan = "SAVE_MAX";
      reason = `deficit ${(-marginMin).toFixed(0)} min; 720p30 at 2000 kbps might finish`;
    } else {
      plan = "PLUG_IN";
      reason = `deficit ${(-marginMin).toFixed(0)} min even at 720p30`;
    }
  }

  if (input.thermalState === "serious") {
    plan = morePowerConservative(plan, "SAVE_RES");
    reason += "; thermal serious";
  }
  if (input.thermalState === "critical") {
    plan = morePowerConservative(plan, "SAVE_MAX");
    reason += "; thermal critical";
  }
  if (input.lowPowerMode) {
    plan = morePowerConservative(plan, "SAVE_FPS");
    reason += "; low power mode";
  }
  if (measured === undefined) reason += `; drain assumed ${drain} %/min`;
  return { minutesToEmpty, minutesRemaining: input.minutesRemaining, willFinish, marginMin, plan, reason };
}

/** The Jev choice question for the power plan. */
export function powerQuestion(input: {
  batteryPct: number;
  charging?: boolean;
  lowPowerMode?: boolean;
  drainPctPerMin?: number;
  minutesRemaining: number;
  thermalState?: string;
}): Record<string, unknown> {
  const drain = input.charging
    ? "charging"
    : `${(input.drainPctPerMin ?? ASSUMED_DRAIN["1080p60"]).toFixed(1)} %/min`;
  return {
    type: "choice",
    criteria: POWER_PLANS,
    instructions: {
      goal:
        "Pick a power plan so the stream finishes the whole game on this phone without dying mid-match.",
      battery: `${input.batteryPct}% ${drain}`,
      minutes_remaining: `${input.minutesRemaining}`,
      thermal: input.thermalState ?? "unknown",
    },
  };
}

/** Advice extended with the applied power plan. */
export type AdviceWithPower = Advice & {
  power?: { plan: string; reason: string; projection?: PowerProjection };
};

/** Lower resolution/bitrate per the plan and record it on the advice. */
export function applyPowerPlan(
  advice: Advice,
  plan: PowerPlan,
  reason: string,
  projection?: PowerProjection
): AdviceWithPower {
  let resolution = advice.resolution;
  if (plan === "SAVE_FPS" && resolution === "1080p60") resolution = "1080p30";
  if (plan === "SAVE_RES" || plan === "SAVE_MAX" || plan === "PLUG_IN") resolution = "720p30";
  let initialKbps = advice.initialKbps;
  let maxKbps = advice.maxKbps;
  let targetKbps = advice.targetKbps;
  let minKbps = advice.minKbps;
  if (plan === "SAVE_MAX" || plan === "PLUG_IN") {
    initialKbps = Math.min(initialKbps, 2000);
    maxKbps = Math.min(maxKbps, 2000);
    targetKbps = Math.min(targetKbps, 2000);
  }
  // The envelope must stay ordered (min <= initial <= max) or the encoder rejects it whole.
  if (minKbps > initialKbps) minKbps = Math.min(initialKbps, 1200);
  if (maxKbps < initialKbps) maxKbps = initialKbps;
  const changed = resolution !== advice.resolution || maxKbps !== advice.maxKbps || targetKbps !== advice.targetKbps;
  const guardrails = plan === "FULL" && !changed
    ? advice.guardrails
    : [...advice.guardrails, `power plan ${plan}: ${reason}`];
  return { ...advice, resolution, initialKbps, minKbps, maxKbps, targetKbps, guardrails, power: { plan, reason, projection } };
}
