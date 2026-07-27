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
// noticed. A first pass here only caught that *exact* shape (every call in
// a fixed 100-call bucket). A rate/hysteresis redesign fixed 99% failure,
// single-tenant-among-many, and mid-window onset — but overshot into the
// opposite failure: with no minimum-sample guard, a cold or freshly-evicted
// tenant could cross the rate watermark off one or two calls and page on
// noise, which is exactly the "alarm cries wolf, gets muted, we're blind
// again" failure mode this module exists to end. See `minSamplesFor` below.

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
  /** Max tenants tracked at once; oldest non-escalated tenant is evicted past this. */
  maxTrackedTenants: number;
}

// windowSize=200: large enough that a single stray flag (1/200 = 0.5%)
// doesn't read as an incident, small enough to fill (and start reporting a
// reliable rate) within a couple hundred calls of any tenant with real
// traffic. It is *not* tied to summaryInterval — reporting cadence and
// detection window are two unrelated concerns.
//
// highWatermark=0.20 / lowWatermark=0.10: healthy operation should show
// ~0% on these flags, so 20% sustained is already well outside normal
// noise and worth paging on; a 10-point gap to the low watermark is enough
// hysteresis that a rate oscillating around 20% doesn't flap log.error /
// log.info every call.
//
// maxTrackedTenants=1000: each tenant's state is a fixed-size circular
// buffer of `windowSize` small flag arrays plus a few counters — at
// windowSize=200 that's roughly 200 * (a handful of pointers) per tenant,
// on the order of tens of KB; 1000 tenants is a low-single-digit-MB bound,
// cheap for a long-lived process without needing a time-based decay loop.
// A host running more concurrent tenants than this in-process should be
// forwarding the snapshot to its own metrics backend anyway
// (getDegradeMetricsSnapshot / getAllDegradeMetricsSnapshots).
const DEFAULT_CONFIG: DegradeMetricsConfig = {
  windowSize: 200,
  summaryInterval: 100,
  highWatermark: 0.2,
  lowWatermark: 0.1,
  maxTrackedTenants: 1000,
};

function validateConfig(next: DegradeMetricsConfig): void {
  if (!Number.isInteger(next.windowSize) || next.windowSize < 1) {
    throw new Error(
      `degrade-metrics: windowSize must be a positive integer, got ${next.windowSize}`,
    );
  }
  if (!Number.isInteger(next.summaryInterval) || next.summaryInterval < 1) {
    throw new Error(
      `degrade-metrics: summaryInterval must be a positive integer, got ${next.summaryInterval}`,
    );
  }
  if (!Number.isInteger(next.maxTrackedTenants) || next.maxTrackedTenants < 1) {
    throw new Error(
      `degrade-metrics: maxTrackedTenants must be a positive integer, got ${next.maxTrackedTenants}`,
    );
  }
  if (!(next.highWatermark > 0 && next.highWatermark <= 1)) {
    throw new Error(
      `degrade-metrics: highWatermark must be in (0, 1], got ${next.highWatermark}`,
    );
  }
  if (!(next.lowWatermark >= 0 && next.lowWatermark < 1)) {
    throw new Error(
      `degrade-metrics: lowWatermark must be in [0, 1), got ${next.lowWatermark}`,
    );
  }
  if (next.highWatermark <= next.lowWatermark) {
    throw new Error(
      `degrade-metrics: highWatermark (${next.highWatermark}) must exceed lowWatermark (${next.lowWatermark})`,
    );
  }

  // INVARIANT: no config this validator accepts may make escalation
  // unreachable. recordDegrade holds off evaluating escalation until a
  // tenant's window has at least minSamplesFor(highWatermark) samples (see
  // that function) — if that floor is non-finite (highWatermark=1, where
  // p*(1-p)=0) or exceeds windowSize (the window can never hold that many
  // samples), the guard added in round 2 to stop cold-start false
  // positives becomes a way to permanently disable the alarm instead,
  // which is the exact CL-4600 failure shape re-armed by config. Any
  // future config knob that affects whether/when escalation can evaluate
  // must extend this same check, not add a separate one.
  const floor = minSamplesFor(next.highWatermark);
  if (!Number.isFinite(floor) || floor > next.windowSize) {
    throw new Error(
      `degrade-metrics: highWatermark ${next.highWatermark} requires ` +
        `${Number.isFinite(floor) ? floor : "an infinite number of"} samples ` +
        `to ever evaluate, but windowSize is only ${next.windowSize} — this ` +
        `config can never escalate. Lower highWatermark or raise windowSize.`,
    );
  }
}

let config: DegradeMetricsConfig = { ...DEFAULT_CONFIG };

/**
 * Lets a host tune cadence/thresholds/eviction without forking the module.
 * Reconfiguring `windowSize` resizes every already-tracked tenant's rolling
 * window immediately (see resizeAllTenantWindows) rather than leaving old
 * tenants on their creation-time buffer size, which previously let
 * `windowedDegradeRate` exceed 1.0 once a tenant's live window count no
 * longer matched its buffer length.
 */
export function configureDegradeMetrics(
  overrides: Partial<DegradeMetricsConfig>,
): void {
  const next = { ...config, ...overrides };
  validateConfig(next);
  const windowSizeChanged = next.windowSize !== config.windowSize;
  config = next;
  if (windowSizeChanged) resizeAllTenantWindows(next.windowSize);
}

// A binomial proportion's normal approximation is considered trustworthy
// once n*p*(1-p) >= 5 (the standard rule of thumb — see e.g. Wackerly,
// Mathematical Statistics). Solving for n at a given watermark gives the
// smallest sample size at which a rate crossing it reflects a real shift
// rather than noise from a handful of early calls. At highWatermark=0.20
// this is ceil(5 / (0.2*0.8)) = 32: below 32 samples, escalation is held
// off entirely rather than evaluated against a rate that isn't yet
// meaningful. At highWatermark=1 this is 5/0 = Infinity — there is no
// finite sample count that makes "100% forever" distinguishable from "100%
// so far", so validateConfig rejects any highWatermark/windowSize
// combination whose floor isn't finite and <= windowSize.
function minSamplesFor(watermark: number): number {
  return Math.ceil(5 / (watermark * (1 - watermark)));
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

function zeroFlagCounts(): Record<DegradeFlag, number> {
  return emptyDegradeCounts();
}

interface TenantState {
  totalSearches: number;
  degradeCounts: Record<DegradeFlag, number>;
  since: Date;
  // Rolling window as a fixed-length circular buffer (sized to
  // config.windowSize at tenant creation, or resized in place by
  // configureDegradeMetrics — see resizeAllTenantWindows) plus a running
  // per-flag count within the buffer, so the windowed rate is an O(1)
  // lookup rather than an O(windowSize) re-scan on every one of the
  // up-to-9 calls per search (3 flags x escalate-check + summary).
  windowBuffer: (readonly DegradeFlag[] | undefined)[];
  windowCursor: number;
  windowFilled: number;
  windowFlagCounts: Record<DegradeFlag, number>;
  /** Hysteresis state per flag: is it currently escalated (log.error)? */
  escalated: Record<DegradeFlag, boolean>;
}

function newTenantState(): TenantState {
  return {
    totalSearches: 0,
    degradeCounts: emptyDegradeCounts(),
    since: new Date(),
    windowBuffer: new Array(config.windowSize).fill(undefined),
    windowCursor: 0,
    windowFilled: 0,
    windowFlagCounts: zeroFlagCounts(),
    escalated: emptyEscalated(),
  };
}

// Map preserves insertion order; touching a tenant (delete + re-set) moves
// it to the end, giving cheap LRU semantics without a separate structure.
let tenants = new Map<string, TenantState>();

// Resizing the buffer instead of forbidding windowSize reconfiguration
// keeps configureDegradeMetrics simple to reason about (no "only before
// any tenant exists" rule to enforce or explain to a host). Every tracked
// tenant's window is reset to empty at the new size: its cumulative
// totals/degradeCounts/since survive (still meaningful at any window
// size), but a stale windowFilled/windowFlagCounts pairing that no longer
// matches the buffer length does not — that mismatch is exactly what
// produced windowedDegradeRate > 1.0. Tenants re-accumulate from zero
// against the new window and are subject to the same minimum-sample floor
// as a brand-new tenant, which is the same, already-accepted cold-start
// trade-off.
function resizeAllTenantWindows(windowSize: number): void {
  for (const state of tenants.values()) {
    state.windowBuffer = new Array(windowSize).fill(undefined);
    state.windowCursor = 0;
    state.windowFilled = 0;
    state.windowFlagCounts = zeroFlagCounts();
    state.escalated = emptyEscalated();
  }
}

function isEscalated(state: TenantState): boolean {
  return ALL_DEGRADE_FLAGS.some((flag) => state.escalated[flag]);
}

// Evicts the oldest tenant that is NOT currently escalated, so an LRU pass
// doesn't make a live incident disappear from getAllDegradeMetricsSnapshots
// just because it's also the tenant a host hasn't polled in a while. If
// every tracked tenant is escalated, capacity still has to be bounded, so
// the oldest one is evicted anyway — loudly, at error level, since losing
// an escalated tenant's state is itself notable.
function evictIfNeeded(): void {
  if (tenants.size < config.maxTrackedTenants) return;
  for (const [id, state] of tenants) {
    if (!isEscalated(state)) {
      tenants.delete(id);
      log.warn(
        `degrade-metrics: evicted tenant ${id} to track a new tenant (max ${config.maxTrackedTenants} tracked)`,
        { evictedTenantId: id, maxTrackedTenants: config.maxTrackedTenants },
      );
      return;
    }
  }
  const oldest = tenants.keys().next().value;
  if (oldest !== undefined) {
    log.error(
      `degrade-metrics: evicting tenant ${oldest} while still escalated — all ${config.maxTrackedTenants} tracked tenants are currently escalated`,
      { evictedTenantId: oldest, maxTrackedTenants: config.maxTrackedTenants },
    );
    tenants.delete(oldest);
  }
}

function touchTenant(tenantId: string): TenantState {
  let state = tenants.get(tenantId);
  if (state) {
    tenants.delete(tenantId);
    tenants.set(tenantId, state);
    return state;
  }
  evictIfNeeded();
  state = newTenantState();
  tenants.set(tenantId, state);
  return state;
}

function pushToWindow(state: TenantState, flags: readonly DegradeFlag[]): void {
  const evicted = state.windowBuffer[state.windowCursor];
  if (evicted) {
    for (const flag of evicted) {
      state.windowFlagCounts[flag] = Math.max(0, state.windowFlagCounts[flag] - 1);
    }
  } else {
    state.windowFilled = Math.min(state.windowFilled + 1, config.windowSize);
  }
  state.windowBuffer[state.windowCursor] = flags;
  for (const flag of flags) {
    state.windowFlagCounts[flag] = (state.windowFlagCounts[flag] ?? 0) + 1;
  }
  state.windowCursor = (state.windowCursor + 1) % state.windowBuffer.length;
}

function windowedRate(state: TenantState, flag: DegradeFlag): number {
  if (state.windowFilled === 0) return 0;
  return state.windowFlagCounts[flag] / state.windowFilled;
}

export interface DegradeMetricsSnapshot {
  tenantId: string;
  /** Lifetime total since `since` — a denominator, not an alerting signal. */
  totalSearches: number;
  /** Lifetime per-flag counts since `since`. */
  degradeCounts: Record<DegradeFlag, number>;
  since: Date;
  /** Number of calls currently backing `windowedDegradeRate` (<= configured windowSize). */
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
    windowedDegradeRate[flag] = windowedRate(state, flag);
  }
  return {
    tenantId,
    totalSearches: state.totalSearches,
    degradeCounts: { ...state.degradeCounts },
    since: state.since,
    windowSize: state.windowFilled,
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

  pushToWindow(state, currentFlags);

  // Hysteresis, checked on every call so onset mid-window escalates
  // immediately rather than waiting for the next periodic summary. Held
  // off entirely below minSamplesFor(highWatermark): a cold or
  // freshly-evicted tenant's early rate isn't statistically meaningful yet,
  // and evaluating it anyway is what pages on noise (see module comment).
  const justEscalated: DegradeFlag[] = [];
  if (state.windowFilled >= minSamplesFor(config.highWatermark)) {
    for (const flag of ALL_DEGRADE_FLAGS) {
      const rate = windowedRate(state, flag);
      const wasEscalated = state.escalated[flag];
      if (rate >= config.highWatermark) {
        state.escalated[flag] = true;
        if (!wasEscalated) justEscalated.push(flag);
      } else if (rate <= config.lowWatermark) {
        state.escalated[flag] = false;
      }
      // Between the watermarks: hold the previous state (hysteresis band).
    }
  }

  for (const flag of justEscalated) {
    const rate = windowedRate(state, flag);
    log.error(
      `search: degrade rate escalation — tenant ${tenantId} flag "${flag}" ` +
        `at ${(rate * 100).toFixed(1)}% over the last ${state.windowFilled} searches ` +
        `(threshold ${(config.highWatermark * 100).toFixed(0)}%)`,
      { tenantId, flag, rate, windowSize: state.windowFilled },
    );
  }

  if (state.totalSearches % config.summaryInterval !== 0) return;

  const rateSummary = ALL_DEGRADE_FLAGS.map(
    (flag) => `${flag}=${(windowedRate(state, flag) * 100).toFixed(1)}%`,
  ).join(", ");
  const anyEscalated = isEscalated(state);
  const summary = {
    tenantId,
    totalSearches: state.totalSearches,
    degradeCounts: { ...state.degradeCounts },
    windowSize: state.windowFilled,
  };
  const message =
    `search: degrade rate summary — tenant ${tenantId}, ` +
    `${state.totalSearches} total searches, last ${state.windowFilled}: ${rateSummary}`;

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
