import { log } from "../log.ts";
import type { DegradeFlag } from "./hybrid-search.ts";

// There is no metrics facility anywhere in this repo — no statsd,
// prometheus, or otel dependency, and `@intx/log` exports no counter. This
// package is a mountable library, not a standalone service that owns its
// own /metrics port, so it must not add one either. What it CAN guarantee
// is a log sink (the one thing every host already has) and an in-process,
// per-tenant snapshot a host with its own metrics backend can poll and
// forward.
//
// CL-4600: reranking degraded on 100% of queries, indefinitely, and nobody
// noticed. The original version of this module only caught that *exact*
// shape — a single flag on literally every call in a fixed 100-call
// bucket. It went silent at 99% (one healthy call per 100 resets the
// bucket), it was defeated by any second tenant sharing the process (one
// tenant's 100%-down window is diluted across everyone else's healthy
// traffic), and its log line dropped every number into a context object
// that some `@intx/log` sinks never render (see formatCaughtError's
// comment in ../log.ts) — the exact bug this same PR fixes elsewhere.
//
// This version:
//   - keys all state per tenant, so one tenant's outage isn't diluted by
//     the other 49's healthy traffic;
//   - escalates on a RATE crossing a threshold within a rolling window,
//     not "every call in a fixed bucket", so 99% (and anything above the
//     threshold) fires;
//   - uses hysteresis (separate escalate/de-escalate watermarks) so a rate
//     bouncing around one threshold doesn't flap between log.info and
//     log.error every call;
//   - checks the rate on every call (not just every SUMMARY_INTERVALth),
//     so onset mid-window pages immediately instead of waiting for the
//     next periodic tick;
//   - interpolates every number into the log message string, because nothing
//     downstream is guaranteed to render the context object;
//   - exposes a windowed rate from getDegradeMetricsSnapshot, since a
//     cumulative-only snapshot dilutes a live incident into an
//     unremarkable lifetime average (9000 healthy + 1000 degraded reads as
//     "10% forever", not "100% right now");
//   - bounds memory with an LRU eviction over tracked tenants instead of
//     growing a map forever.

const DEGRADE_FLAG_SET = {
  dense_unavailable: true,
  rerank_unavailable: true,
  rerank_query_too_long: true,
} satisfies Record<DegradeFlag, true>;

// Deriving the list from a `satisfies Record<DegradeFlag, true>` object
// means adding a flag in hybrid-search.ts without adding it here is a
// compile error (missing property), not a silent gap that only a test
// iterating this same constant could ever have caught.
export const ALL_DEGRADE_FLAGS: readonly DegradeFlag[] = Object.keys(
  DEGRADE_FLAG_SET,
) as DegradeFlag[];

export interface DegradeMetricsConfig {
  /** Rolling per-tenant window (in calls) the rate is computed over. */
  windowSize: number;
  /** How often (in a tenant's own call count) the periodic summary fires. */
  summaryInterval: number;
  /** Windowed rate at/above which a flag escalates to log.error. */
  highWatermark: number;
  /** Windowed rate at/below which an escalated flag returns to log.info. */
  lowWatermark: number;
  /** Max tenants tracked at once; oldest-touched tenant is evicted past this. */
  maxTrackedTenants: number;
}

// windowSize=200: large enough that a single stray flag (1/200 = 0.5%)
// doesn't read as an incident, small enough to fill (and start reporting a
// reliable rate) within a couple hundred calls of any tenant with real
// traffic. It is *not* tied to summaryInterval — issue #7 was two
// unrelated concerns (reporting cadence vs. detection window) fused into
// one constant.
//
// highWatermark=0.20 / lowWatermark=0.10: healthy operation should show
// ~0% on these flags, so 20% sustained is already well outside normal
// noise and worth paging on; a 10-point gap to the low watermark is enough
// hysteresis that a rate oscillating around 20% doesn't flap log.error /
// log.info every call. Both watermarks sit far enough below the 99% and
// 100% incident shapes the ticket names that they fire almost immediately
// once the window has enough samples to reflect the true rate — the
// escalation check runs on every call, not just at a periodic boundary,
// so it does not wait for the window to fully refill before firing.
//
// maxTrackedTenants=1000: bounds worst-case memory for a long-lived
// process without needing a time-based decay loop; a host running more
// concurrent tenants than this in-process should be forwarding the
// snapshot to its own metrics backend anyway (getDegradeMetricsSnapshot /
// getAllDegradeMetricsSnapshots), which is unaffected by eviction here
// beyond losing the evicted tenant's rolling window.
const DEFAULT_CONFIG: DegradeMetricsConfig = {
  windowSize: 200,
  summaryInterval: 100,
  highWatermark: 0.2,
  lowWatermark: 0.1,
  maxTrackedTenants: 1000,
};

let config: DegradeMetricsConfig = { ...DEFAULT_CONFIG };

/** Lets a host tune cadence/thresholds/eviction without forking the module. */
export function configureDegradeMetrics(
  overrides: Partial<DegradeMetricsConfig>,
): void {
  const next = { ...config, ...overrides };
  if (next.highWatermark <= next.lowWatermark) {
    throw new Error(
      `degrade-metrics: highWatermark (${next.highWatermark}) must exceed lowWatermark (${next.lowWatermark})`,
    );
  }
  config = next;
}

function emptyDegradeCounts(): Record<DegradeFlag, number> {
  const counts = {} as Record<DegradeFlag, number>;
  for (const flag of ALL_DEGRADE_FLAGS) counts[flag] = 0;
  return counts;
}

function emptyEscalated(): Record<DegradeFlag, boolean> {
  const escalated = {} as Record<DegradeFlag, boolean>;
  for (const flag of ALL_DEGRADE_FLAGS) escalated[flag] = false;
  return escalated;
}

interface TenantState {
  totalSearches: number;
  degradeCounts: Record<DegradeFlag, number>;
  since: Date;
  /** Rolling window of the last `windowSize` calls' flags for this tenant. */
  window: (readonly DegradeFlag[])[];
  /** Hysteresis state per flag: is it currently escalated (log.error)? */
  escalated: Record<DegradeFlag, boolean>;
}

function newTenantState(): TenantState {
  return {
    totalSearches: 0,
    degradeCounts: emptyDegradeCounts(),
    since: new Date(),
    window: [],
    escalated: emptyEscalated(),
  };
}

// Map preserves insertion order; touching a tenant (delete + re-set) moves
// it to the end, giving cheap LRU semantics without a separate structure.
let tenants = new Map<string, TenantState>();

function touchTenant(tenantId: string): TenantState {
  let state = tenants.get(tenantId);
  if (state) {
    tenants.delete(tenantId);
    tenants.set(tenantId, state);
    return state;
  }
  state = newTenantState();
  if (tenants.size >= config.maxTrackedTenants) {
    const oldest = tenants.keys().next().value;
    if (oldest !== undefined) tenants.delete(oldest);
  }
  tenants.set(tenantId, state);
  return state;
}

function windowedRate(window: (readonly DegradeFlag[])[], flag: DegradeFlag): number {
  if (window.length === 0) return 0;
  const hits = window.reduce(
    (n, entry) => (entry.includes(flag) ? n + 1 : n),
    0,
  );
  return hits / window.length;
}

export interface DegradeMetricsSnapshot {
  tenantId: string;
  /** Lifetime total since `since` — a denominator, not an alerting signal. */
  totalSearches: number;
  /** Lifetime per-flag counts since `since`. */
  degradeCounts: Record<DegradeFlag, number>;
  since: Date;
  /** Size of the rolling window backing `windowedDegradeRate`. */
  windowSize: number;
  /**
   * Per-flag rate over the last `windowSize` calls. This — not
   * `degradeCounts` — is what a host should alert on: a lifetime total
   * dilutes a live incident into an unremarkable-looking average.
   */
  windowedDegradeRate: Record<DegradeFlag, number>;
  /** Whether each flag is currently past the escalate watermark. */
  escalated: Record<DegradeFlag, boolean>;
}

function toSnapshot(tenantId: string, state: TenantState): DegradeMetricsSnapshot {
  const windowedDegradeRate = {} as Record<DegradeFlag, number>;
  for (const flag of ALL_DEGRADE_FLAGS) {
    windowedDegradeRate[flag] = windowedRate(state.window, flag);
  }
  return {
    tenantId,
    totalSearches: state.totalSearches,
    degradeCounts: { ...state.degradeCounts },
    since: state.since,
    windowSize: state.window.length,
    windowedDegradeRate,
    escalated: { ...state.escalated },
  };
}

/**
 * Records one `hybridSearch` invocation's outcome for one tenant. Called
 * exactly once per invocation, covering every degrade path AND the fully
 * healthy case (an empty/undefined `flags`) — `totalSearches` is the
 * denominator a rate needs; without it, a raw degrade count is exactly as
 * opaque as no count at all.
 */
export function recordDegrade(
  tenantId: string,
  flags: readonly DegradeFlag[] | undefined,
): void {
  const state = touchTenant(tenantId);
  state.totalSearches += 1;
  const currentFlags = flags ?? [];
  for (const flag of currentFlags) {
    state.degradeCounts[flag] = (state.degradeCounts[flag] ?? 0) + 1;
  }

  state.window.push(currentFlags);
  if (state.window.length > config.windowSize) {
    state.window = state.window.slice(-config.windowSize);
  }

  // Hysteresis, checked on every call so onset mid-window escalates
  // immediately rather than waiting for the next periodic summary.
  const justEscalated: DegradeFlag[] = [];
  for (const flag of ALL_DEGRADE_FLAGS) {
    const rate = windowedRate(state.window, flag);
    const wasEscalated = state.escalated[flag];
    if (rate >= config.highWatermark) {
      state.escalated[flag] = true;
      if (!wasEscalated) justEscalated.push(flag);
    } else if (rate <= config.lowWatermark) {
      state.escalated[flag] = false;
    }
    // Between the watermarks: hold the previous state (hysteresis band).
  }

  for (const flag of justEscalated) {
    const rate = windowedRate(state.window, flag);
    log.error(
      `search: degrade rate escalation — tenant ${tenantId} flag "${flag}" ` +
        `at ${(rate * 100).toFixed(1)}% over the last ${state.window.length} searches ` +
        `(threshold ${(config.highWatermark * 100).toFixed(0)}%)`,
      { tenantId, flag, rate, windowSize: state.window.length },
    );
  }

  if (state.totalSearches % config.summaryInterval !== 0) return;

  const rateSummary = ALL_DEGRADE_FLAGS.map(
    (flag) => `${flag}=${(windowedRate(state.window, flag) * 100).toFixed(1)}%`,
  ).join(", ");
  const anyEscalated = ALL_DEGRADE_FLAGS.some((flag) => state.escalated[flag]);
  const summary = {
    tenantId,
    totalSearches: state.totalSearches,
    degradeCounts: { ...state.degradeCounts },
    windowSize: state.window.length,
  };
  const message =
    `search: degrade rate summary — tenant ${tenantId}, ` +
    `${state.totalSearches} total searches, last ${state.window.length}: ${rateSummary}`;

  if (anyEscalated) {
    log.error(message, summary);
  } else {
    log.info(message, summary);
  }
}

/** Read-only snapshot for a host to expose on its own metrics/health endpoint. */
export function getDegradeMetricsSnapshot(tenantId: string): DegradeMetricsSnapshot {
  const state = tenants.get(tenantId) ?? newTenantState();
  return toSnapshot(tenantId, state);
}

/** All currently-tracked tenants, for a host that wants to poll/forward every one. */
export function getAllDegradeMetricsSnapshots(): DegradeMetricsSnapshot[] {
  return Array.from(tenants.entries()).map(([tenantId, state]) =>
    toSnapshot(tenantId, state),
  );
}

/** Test-only reset. */
export function resetDegradeMetrics(): void {
  tenants = new Map();
  config = { ...DEFAULT_CONFIG };
}
