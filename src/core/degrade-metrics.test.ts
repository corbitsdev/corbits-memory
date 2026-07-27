import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  ALL_DEGRADE_FLAGS,
  configureDegradeMetrics,
  getAllDegradeMetricsSnapshots,
  getDegradeMetricsSnapshot,
  recordDegrade,
  resetDegradeMetrics,
} from "./degrade-metrics.ts";
import { log } from "../log.ts";

function captureLogs() {
  const calls: Array<{ level: "info" | "error"; message: string; payload: unknown }> = [];
  const originalInfo = log.info;
  const originalError = log.error;
  log.info = ((message: string, payload?: unknown) => {
    calls.push({ level: "info", message, payload });
  }) as unknown as typeof log.info;
  log.error = ((message: string, payload?: unknown) => {
    calls.push({ level: "error", message, payload });
  }) as unknown as typeof log.error;
  return {
    calls,
    restore: () => {
      log.info = originalInfo;
      log.error = originalError;
    },
  };
}

describe("degrade-metrics", () => {
  beforeEach(() => {
    resetDegradeMetrics();
  });

  afterEach(() => {
    resetDegradeMetrics();
  });

  it("counts totalSearches on every call, including the fully healthy case", () => {
    recordDegrade("tenant-a", undefined);
    recordDegrade("tenant-a", []);
    recordDegrade("tenant-a", ["dense_unavailable"]);
    expect(getDegradeMetricsSnapshot("tenant-a").totalSearches).toBe(3);
  });

  it("increments a per-flag counter for each flag present, without double-counting across flags", () => {
    recordDegrade("tenant-a", ["dense_unavailable"]);
    recordDegrade("tenant-a", ["rerank_unavailable", "rerank_query_too_long"]);
    recordDegrade("tenant-a", undefined);

    const snapshot = getDegradeMetricsSnapshot("tenant-a");
    expect(snapshot.degradeCounts.dense_unavailable).toBe(1);
    expect(snapshot.degradeCounts.rerank_unavailable).toBe(1);
    expect(snapshot.degradeCounts.rerank_query_too_long).toBe(1);
  });

  it("snapshot shape includes totalSearches, degradeCounts/windowedDegradeRate keyed by every known flag, and since", () => {
    const snapshot = getDegradeMetricsSnapshot("tenant-a");
    expect(snapshot.totalSearches).toBe(0);
    expect(snapshot.since).toBeInstanceOf(Date);
    for (const flag of ALL_DEGRADE_FLAGS) {
      expect(snapshot.degradeCounts[flag]).toBe(0);
      expect(snapshot.windowedDegradeRate[flag]).toBe(0);
    }
  });

  it("resetDegradeMetrics clears counts and totals back to zero", () => {
    recordDegrade("tenant-a", ["rerank_unavailable"]);
    resetDegradeMetrics();
    const snapshot = getDegradeMetricsSnapshot("tenant-a");
    expect(snapshot.totalSearches).toBe(0);
    expect(snapshot.degradeCounts.rerank_unavailable).toBe(0);
  });

  it("interpolates every summary number into the log message, since some sinks drop the context object", () => {
    const { calls, restore } = captureLogs();
    try {
      // Below the escalate watermark, so the periodic summary stays log.info
      // — but the message string alone (no context object) must still show
      // the numbers a human needs.
      for (let i = 0; i < 90; i++) recordDegrade("tenant-a", undefined);
      for (let i = 0; i < 10; i++) recordDegrade("tenant-a", ["dense_unavailable"]);
      const info = calls.find((c) => c.level === "info");
      expect(info).toBeDefined();
      expect(calls.some((c) => c.level === "error")).toBe(false);
      expect(info!.message).toContain("100");
      expect(info!.message).toContain("dense_unavailable");
      expect(info!.message).toMatch(/%/);
    } finally {
      restore();
    }
  });

  describe("rate-based escalation with hysteresis", () => {
    it("escalates on a saturated window (the original CL-4600 shape: 100% for 100+ calls)", () => {
      const { calls, restore } = captureLogs();
      try {
        for (let i = 0; i < 100; i++) recordDegrade("tenant-a", ["rerank_unavailable"]);
        const error = calls.find((c) => c.level === "error");
        expect(error).toBeDefined();
        expect(error!.message).toContain("rerank_unavailable");
      } finally {
        restore();
      }
    });

    it("escalates at 99% failure (one healthy call per 100) — the exact gap a binary saturation check misses", () => {
      const { calls, restore } = captureLogs();
      try {
        for (let i = 0; i < 2000; i++) {
          recordDegrade("tenant-a", i % 100 === 50 ? undefined : ["rerank_unavailable"]);
        }
        const errors = calls.filter((c) => c.level === "error");
        expect(errors.length).toBeGreaterThan(0);
      } finally {
        restore();
      }
    });

    it("escalates immediately on mid-run onset, not only at a periodic boundary", () => {
      const { calls, restore } = captureLogs();
      try {
        for (let i = 0; i < 1001; i++) recordDegrade("tenant-a", undefined);
        calls.length = 0;
        let escalatedAtCall = -1;
        for (let i = 0; i < 300; i++) {
          recordDegrade("tenant-a", ["rerank_unavailable"]);
          if (escalatedAtCall === -1 && calls.some((c) => c.level === "error")) {
            escalatedAtCall = i;
          }
        }
        expect(escalatedAtCall).toBeGreaterThanOrEqual(0);
        // Should not need to wait for the window to fully saturate again;
        // it fires once the rolling rate crosses the high watermark.
        expect(escalatedAtCall).toBeLessThan(200);
      } finally {
        restore();
      }
    });

    it("does not escalate on an isolated blip below the watermark", () => {
      const { calls, restore } = captureLogs();
      try {
        for (let i = 0; i < 199; i++) recordDegrade("tenant-a", undefined);
        recordDegrade("tenant-a", ["rerank_unavailable"]);
        expect(calls.some((c) => c.level === "error")).toBe(false);
      } finally {
        restore();
      }
    });

    it("hysteresis prevents flapping: once escalated, a dip that doesn't cross the low watermark stays escalated without re-logging error on every call", () => {
      const { calls, restore } = captureLogs();
      try {
        for (let i = 0; i < 200; i++) recordDegrade("tenant-a", ["rerank_unavailable"]);
        const escalationsAfterSaturation = calls.filter((c) => c.level === "error").length;
        // A single healthy call (rate stays well above the low watermark)
        // should not cause a second escalation transition.
        recordDegrade("tenant-a", undefined);
        const escalationsAfterOneHealthyCall = calls.filter((c) => c.level === "error").length;
        expect(escalationsAfterOneHealthyCall).toBe(escalationsAfterSaturation);
      } finally {
        restore();
      }
    });
  });

  describe("multi-tenant isolation", () => {
    it("a single tenant fully down among 50 healthy tenants still escalates for that tenant", () => {
      const { calls, restore } = captureLogs();
      try {
        for (let t = 0; t < 49; t++) {
          for (let i = 0; i < 50; i++) recordDegrade(`tenant-${t}`, undefined);
        }
        for (let i = 0; i < 200; i++) recordDegrade("tenant-down", ["rerank_unavailable"]);

        const downErrors = calls.filter(
          (c) => c.level === "error" && c.message.includes("tenant-down"),
        );
        expect(downErrors.length).toBeGreaterThan(0);

        const otherErrors = calls.filter(
          (c) => c.level === "error" && !c.message.includes("tenant-down"),
        );
        expect(otherErrors.length).toBe(0);
      } finally {
        restore();
      }
    });

    it("keeps independent windows/counts per tenant", () => {
      for (let i = 0; i < 10; i++) recordDegrade("tenant-a", ["dense_unavailable"]);
      for (let i = 0; i < 5; i++) recordDegrade("tenant-b", undefined);

      expect(getDegradeMetricsSnapshot("tenant-a").totalSearches).toBe(10);
      expect(getDegradeMetricsSnapshot("tenant-b").totalSearches).toBe(5);
      expect(getDegradeMetricsSnapshot("tenant-a").degradeCounts.dense_unavailable).toBe(10);
      expect(getDegradeMetricsSnapshot("tenant-b").degradeCounts.dense_unavailable).toBe(0);
    });

    it("getAllDegradeMetricsSnapshots exposes every tracked tenant for a host to poll/forward", () => {
      recordDegrade("tenant-a", undefined);
      recordDegrade("tenant-b", undefined);
      const all = getAllDegradeMetricsSnapshots();
      const tenantIds = all.map((s) => s.tenantId).sort();
      expect(tenantIds).toEqual(["tenant-a", "tenant-b"]);
    });

    it("evicts the least-recently-touched tenant once maxTrackedTenants is exceeded", () => {
      configureDegradeMetrics({ maxTrackedTenants: 2 });
      recordDegrade("tenant-a", undefined);
      recordDegrade("tenant-b", undefined);
      recordDegrade("tenant-c", undefined);

      const tenantIds = getAllDegradeMetricsSnapshots().map((s) => s.tenantId);
      expect(tenantIds).not.toContain("tenant-a");
      expect(tenantIds).toContain("tenant-b");
      expect(tenantIds).toContain("tenant-c");
    });
  });

  describe("windowed vs. cumulative snapshot (dilution)", () => {
    it("the snapshot exposes a windowed rate that reflects a live incident even when the cumulative rate looks tame", () => {
      for (let i = 0; i < 9000; i++) recordDegrade("tenant-a", undefined);
      for (let i = 0; i < 1000; i++) recordDegrade("tenant-a", ["rerank_unavailable"]);

      const snapshot = getDegradeMetricsSnapshot("tenant-a");
      const cumulativeRate =
        snapshot.degradeCounts.rerank_unavailable / snapshot.totalSearches;
      expect(cumulativeRate).toBeCloseTo(0.1, 1);
      // The windowed rate reflects the live incident, not the lifetime dilution.
      expect(snapshot.windowedDegradeRate.rerank_unavailable).toBeGreaterThan(0.9);
      expect(snapshot.escalated.rerank_unavailable).toBe(true);
    });
  });
});
