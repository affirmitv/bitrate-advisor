// src/events.ts — event-driven advice: react to telemetry events immediately.
import type { Telemetry, History, Advice, AdvisorOptions } from "./advisor.ts";
import { advise } from "./advisor.ts";

/** Telemetry-derived event types. */
export type TelemetryEventType =
  | "disconnect" | "reconnect" | "thermal_change" | "battery_low"
  | "charger_connected" | "charger_disconnected" | "network_change"
  | "bitrate_stepdown" | "dropped_frames_spike" | "send_queue_growing"
  | "period_break" | "manual_check";

/** A single telemetry event. */
export type TelemetryEvent = { type: TelemetryEventType; atMs: number; detail?: string };

/** Events that bypass the debounce window. */
export const URGENT: ReadonlySet<TelemetryEventType> = new Set([
  "disconnect", "thermal_change", "battery_low", "network_change",
  "dropped_frames_spike", "send_queue_growing",
]);

/** Reacts to telemetry events and periodic ticks, calling advise(). */
export class EventAdvisor {
  lastAdvice: Advice | null = null;
  lastAt: number | null = null;
  history: string[] = [];
  private debounceMs: number;
  private minTickGapMs: number;
  private now: () => number;
  private opts: AdvisorOptions;
  private firstAt: number | null = null;

  constructor(
    opts: AdvisorOptions = {},
    timing: { debounceMs?: number; minTickGapMs?: number; now?: () => number } = {}
  ) {
    this.opts = opts;
    this.debounceMs = timing.debounceMs ?? 3000;
    this.minTickGapMs = timing.minTickGapMs ?? 5000;
    this.now = timing.now ?? Date.now;
  }

  /** "t+<s>s <type>[: detail]" relative to the first event seen. */
  describe(e: TelemetryEvent): string {
    if (this.firstAt === null) this.firstAt = e.atMs;
    const secs = Math.max(0, Math.round((e.atMs - this.firstAt) / 1000));
    return `t+${secs}s ${e.type}${e.detail ? `: ${e.detail}` : ""}`;
  }

  /** Urgent events always react; others are debounced against lastAt. */
  shouldReact(e: TelemetryEvent): boolean {
    if (URGENT.has(e.type)) return true;
    if (this.lastAt === null) return true;
    return this.now() - this.lastAt >= this.debounceMs;
  }

  /** Handle one event; returns fresh advice or null when debounced. */
  async onEvent(e: TelemetryEvent, t: Telemetry, h: History): Promise<Advice | null> {
    if (!this.shouldReact(e)) return null;
    this.history.push(this.describe(e));
    if (this.history.length > 12) this.history = this.history.slice(-12);
    const advice = await advise("tick", { ...t, recentActions: this.history.slice(-8) }, h, this.opts);
    this.lastAdvice = advice;
    this.lastAt = this.now();
    this.history.push(`advised ${advice.nextStep} -> ${advice.targetKbps}`);
    if (this.history.length > 12) this.history = this.history.slice(-12);
    return advice;
  }

  /** Periodic tick, throttled by minTickGapMs. */
  async onTick(t: Telemetry, h: History): Promise<Advice | null> {
    if (this.lastAt !== null && this.now() - this.lastAt < this.minTickGapMs) return null;
    const advice = await advise("tick", { ...t, recentActions: this.history.slice(-8) }, h, this.opts);
    this.lastAdvice = advice;
    this.lastAt = this.now();
    this.history.push(`advised ${advice.nextStep} -> ${advice.targetKbps}`);
    if (this.history.length > 12) this.history = this.history.slice(-12);
    return advice;
  }

  /** Derive events from two consecutive telemetry samples. */
  static eventsFromDelta(prev: Telemetry | null, next: Telemetry, atMs: number): TelemetryEvent[] {
    const events: TelemetryEvent[] = [];
    if (!prev) return events;
    const charging = (t: Telemetry) => (t as { charging?: boolean }).charging;
    if (next.thermalState !== prev.thermalState) {
      events.push({ type: "thermal_change", atMs, detail: `${prev.thermalState ?? "unknown"} -> ${next.thermalState ?? "unknown"}` });
    }
    const pb = prev.batteryPct ?? 100;
    const nb = next.batteryPct ?? 100;
    if (pb >= 20 && nb < 20) events.push({ type: "battery_low", atMs, detail: "below 20%" });
    if (pb >= 10 && nb < 10) events.push({ type: "battery_low", atMs, detail: "below 10%" });
    const pc = charging(prev);
    const nc = charging(next);
    if (pc !== undefined && nc !== undefined && pc !== nc) {
      events.push({ type: nc ? "charger_connected" : "charger_disconnected", atMs });
    }
    if (next.networkType !== prev.networkType || next.carrierAsn !== prev.carrierAsn) {
      events.push({ type: "network_change", atMs, detail: `${prev.networkType ?? "?"}/${prev.carrierAsn ?? "?"} -> ${next.networkType ?? "?"}/${next.carrierAsn ?? "?"}` });
    }
    const pe = prev.encoderKbps;
    const ne = next.encoderKbps;
    if (pe !== undefined && ne !== undefined && pe > 0 && ne <= pe * 0.8) {
      events.push({ type: "bitrate_stepdown", atMs, detail: `${pe} -> ${ne} kbps` });
    }
    const pd = prev.droppedFramesPct ?? 0;
    const nd = next.droppedFramesPct ?? 0;
    if (pd <= 3 && nd > 3) events.push({ type: "dropped_frames_spike", atMs, detail: `${nd}%` });
    const pq = prev.sendQueueMs ?? 0;
    const nq = next.sendQueueMs ?? 0;
    if (pq <= 1000 && nq > 1000) events.push({ type: "send_queue_growing", atMs, detail: `${nq} ms` });
    return events;
  }
}
