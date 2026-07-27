import { log } from "../log.ts";
import type { DegradeFlag } from "./hybrid-search.ts";

// There is no metrics facility anywhere in this repo — no statsd,
// prometheus, or otel dependency, and `@intx/log` exports no counter. This
// package is a mountable library, not a standalone service that owns its
// own /metrics port, so it must not add one either. What it CAN guarantee
// is a log sink (the one thing every host already has) and an in-process
// snapshot a host with its own metrics backend can poll and forward.
//
// This is what makes a sustained degrade rate — the CL-4600 incident:
// reranking degraded on 100% of queries, indefinitely, and nobody
// noticed — visible without reading individual log lines: every
// `SUMMARY_INTERVAL`th call emits a structured rate summary, and a fully
// saturated window escalates to `log.error` instead of `log.info`.

export const ALL_DEGRADE_FLAGS: readonly DegradeFlag[] = [
  "dense_unavailable",
  "rerank_unavailable",
  "rerank_query_too_long",
];

// How often (in total searches) the periodic summary is emitted. A `setInterval`
// would add a background timer to a library that doesn't otherwise run one,
// and whose lifecycle (start/stop, multiple mounts) this package doesn't
// own — counting calls instead means the summary rides the same call stack
// as the search it's reporting on, with no timer to leak or double-start.
const SUMMARY_INTERVAL = 100;

// The window used to detect "every recent search carried this flag" — the
// shape of the CL-4600 incident. Sized to the same cadence as the periodic
// summary so both fire together.
const SATURATION_WINDOW = SUMMARY_INTERVAL;

function emptyDegradeCounts(): Record<DegradeFlag, number> {
  const counts = {} as Record<DegradeFlag, number>;
  for (const flag of ALL_DEGRADE_FLAGS) counts[flag] = 0;
  return counts;
}

let totalSearches = 0;
let degradeCounts: Record<DegradeFlag, number> = emptyDegradeCounts();
let since = new Date();
// Rolling window of the last SATURATION_WINDOW calls' flags — used only to
// detect full saturation on a single flag; not part of the exported
// snapshot, which stays cumulative-since-`since`.
let window: (readonly DegradeFlag[])[] = [];

export interface DegradeMetricsSnapshot {
  totalSearches: number;
  degradeCounts: Record<DegradeFlag, number>;
  since: Date;
}

/**
 * Records one `hybridSearch` invocation's outcome. Called exactly once per
 * invocation, covering every degrade path AND the fully healthy case (an
 * empty/undefined `flags`) — `totalSearches` is the denominator a rate needs;
 * without it, a raw degrade count is exactly as opaque as no count at all.
 */
export function recordDegrade(flags: readonly DegradeFlag[] | undefined): void {
  totalSearches += 1;
  const currentFlags = flags ?? [];
  for (const flag of currentFlags) {
    degradeCounts[flag] = (degradeCounts[flag] ?? 0) + 1;
  }

  window.push(currentFlags);
  if (window.length > SATURATION_WINDOW) {
    window = window.slice(-SATURATION_WINDOW);
  }

  if (totalSearches % SUMMARY_INTERVAL !== 0) return;

  const saturatedFlag = ALL_DEGRADE_FLAGS.find(
    (flag) =>
      window.length === SATURATION_WINDOW &&
      window.every((entry) => entry.includes(flag)),
  );

  const summary = {
    totalSearches,
    degradeCounts: { ...degradeCounts },
    windowSize: window.length,
  };

  if (saturatedFlag) {
    log.error(
      `search: degrade rate summary — "${saturatedFlag}" present on 100% of the last ${window.length} searches`,
      summary,
    );
  } else {
    log.info("search: degrade rate summary", summary);
  }
}

/** Read-only snapshot for a host to expose on its own metrics/health endpoint. */
export function getDegradeMetricsSnapshot(): DegradeMetricsSnapshot {
  return {
    totalSearches,
    degradeCounts: { ...degradeCounts },
    since,
  };
}

/** Test-only reset. */
export function resetDegradeMetrics(): void {
  totalSearches = 0;
  degradeCounts = emptyDegradeCounts();
  since = new Date();
  window = [];
}
