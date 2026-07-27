import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  ALL_DEGRADE_FLAGS,
  getDegradeMetricsSnapshot,
  recordDegrade,
  resetDegradeMetrics,
} from "./degrade-metrics.ts";
import { log } from "../log.ts";

describe("degrade-metrics", () => {
  beforeEach(() => {
    resetDegradeMetrics();
  });

  afterEach(() => {
    resetDegradeMetrics();
  });

  it("counts totalSearches on every call, including the fully healthy case", () => {
    recordDegrade(undefined);
    recordDegrade([]);
    recordDegrade(["dense_unavailable"]);
    expect(getDegradeMetricsSnapshot().totalSearches).toBe(3);
  });

  it("increments a per-flag counter for each flag present, without double-counting across flags", () => {
    recordDegrade(["dense_unavailable"]);
    recordDegrade(["rerank_unavailable", "rerank_query_too_long"]);
    recordDegrade(undefined);

    const snapshot = getDegradeMetricsSnapshot();
    expect(snapshot.degradeCounts.dense_unavailable).toBe(1);
    expect(snapshot.degradeCounts.rerank_unavailable).toBe(1);
    expect(snapshot.degradeCounts.rerank_query_too_long).toBe(1);
  });

  it("snapshot shape includes totalSearches, degradeCounts keyed by every known flag, and since", () => {
    const snapshot = getDegradeMetricsSnapshot();
    expect(snapshot.totalSearches).toBe(0);
    expect(snapshot.since).toBeInstanceOf(Date);
    for (const flag of ALL_DEGRADE_FLAGS) {
      expect(snapshot.degradeCounts[flag]).toBe(0);
    }
  });

  it("resetDegradeMetrics clears counts and totals back to zero", () => {
    recordDegrade(["rerank_unavailable"]);
    resetDegradeMetrics();
    const snapshot = getDegradeMetricsSnapshot();
    expect(snapshot.totalSearches).toBe(0);
    expect(snapshot.degradeCounts.rerank_unavailable).toBe(0);
  });

  it("emits a log.info rate summary every 100th call when degradation is mixed/absent", () => {
    const infoSpy = mock(() => {});
    const errorSpy = mock(() => {});
    const originalInfo = log.info;
    const originalError = log.error;
    log.info = infoSpy as unknown as typeof log.info;
    log.error = errorSpy as unknown as typeof log.error;
    try {
      for (let i = 0; i < 99; i++) recordDegrade(undefined);
      expect(infoSpy).not.toHaveBeenCalled();
      recordDegrade(["dense_unavailable"]);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
      const [message, payload] = infoSpy.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(message).toContain("degrade rate summary");
      expect(payload.totalSearches).toBe(100);
    } finally {
      log.info = originalInfo;
      log.error = originalError;
    }
  });

  it("escalates to log.error instead of log.info when a single flag saturates 100% of the window — the exact shape of the CL-4600 incident", () => {
    const infoSpy = mock(() => {});
    const errorSpy = mock(() => {});
    const originalInfo = log.info;
    const originalError = log.error;
    log.info = infoSpy as unknown as typeof log.info;
    log.error = errorSpy as unknown as typeof log.error;
    try {
      for (let i = 0; i < 100; i++) recordDegrade(["rerank_unavailable"]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).not.toHaveBeenCalled();
      const [message] = errorSpy.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(message).toContain("rerank_unavailable");
      expect(message).toContain("100%");
    } finally {
      log.info = originalInfo;
      log.error = originalError;
    }
  });

  it("does not escalate when the same window mixes a degrade flag with healthy calls (not fully saturated)", () => {
    const infoSpy = mock(() => {});
    const errorSpy = mock(() => {});
    const originalInfo = log.info;
    const originalError = log.error;
    log.info = infoSpy as unknown as typeof log.info;
    log.error = errorSpy as unknown as typeof log.error;
    try {
      for (let i = 0; i < 50; i++) recordDegrade(["rerank_unavailable"]);
      for (let i = 0; i < 50; i++) recordDegrade(undefined);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      log.info = originalInfo;
      log.error = originalError;
    }
  });
});
