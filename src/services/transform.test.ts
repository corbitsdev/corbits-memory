import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  buildRerankClientConfig,
  isPromotableRunStatus,
  promoteGeneration,
  runTransform,
  TransformPromoteError,
} from "./transform.ts";
import { TransformConfigParamsSchema } from "../core/schemas/transform.ts";
import { rawCapture, transformConfig, transformRun } from "../db/schema.ts";
import type { Db, RawSql } from "../db/client.ts";
import type { EngineConfig } from "../config.ts";

describe("buildRerankClientConfig", () => {
  it("returns undefined when no baseUrl is configured (falls through to engine defaults)", () => {
    expect(buildRerankClientConfig(undefined)).toBeUndefined();
    expect(buildRerankClientConfig({})).toBeUndefined();
  });

  it("defaults apiStyle to 'tei' when omitted, mirroring the engine's own rerank config precedent", () => {
    const config = buildRerankClientConfig({ baseUrl: "https://rerank.example" });
    expect(config).toEqual({
      baseUrl: "https://rerank.example",
      apiStyle: "tei",
    });
  });

  it("carries the configured apiStyle and model through untouched", () => {
    const config = buildRerankClientConfig({
      baseUrl: "https://rerank.example",
      apiStyle: "cohere",
      model: "rerank-v3",
    });
    expect(config).toEqual({
      baseUrl: "https://rerank.example",
      apiStyle: "cohere",
      model: "rerank-v3",
    });
  });
});

describe("isPromotableRunStatus", () => {
  it("allows only completed runs", () => {
    expect(isPromotableRunStatus("completed")).toBe(true);
    expect(isPromotableRunStatus("running")).toBe(false);
    expect(isPromotableRunStatus("failed")).toBe(false);
  });
});

describe("TransformConfigParamsSchema", () => {
  it("accepts a fully-specified params object", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive", maxTokens: 500 },
      embed: { baseUrl: "http://localhost:11434", model: "nomic-embed-text", apiStyle: "ollama" },
      rerank: { baseUrl: "https://rerank.example", apiStyle: "tei" },
      authorityWeight: 0.8,
      recencyHalfLifeDays: 45,
      mmrLambda: 0.6,
      overfetch: 4,
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects an unknown chunk strategy — token.recursive is the only one adaptAndPlan supports", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "semantic.experimental" },
      embed: { baseUrl: "http://localhost:11434", model: "nomic-embed-text", apiStyle: "ollama" },
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  it("accepts a partial embed override — every omitted field inherits the engine's embed config", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive" },
      embed: { model: "a-different-model" },
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("accepts params with no embed override at all — the replay reuses the engine's embed endpoint", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive" },
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects an unknown embed apiStyle", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive" },
      embed: { apiStyle: "not-a-real-style" },
    });
    expect(parsed instanceof type.errors).toBe(true);
  });
});

// CL-6287 review: runTransform/promoteGeneration grew embed-absent guards in
// this PR with no coverage — a host running a replay or rebuild-derived job
// while lexical-only would execute code nobody had exercised. A minimal
// drizzle-shaped `Db` fake (same technique as services/search.test.ts's
// hybridSearch coverage) stands in for the handful of queries each function
// issues before reaching the guard; `.set`/`.values` calls are captured so
// assertions can inspect exactly what the code under test computed, rather
// than reading back through the same static fake.
describe("runTransform / promoteGeneration — embed-absent guards (CL-6287)", () => {
  const TENANT = "tenant-1";
  const CONFIG_ID = "tcfg_1";

  function configRow() {
    return {
      id: CONFIG_ID,
      tenantId: TENANT,
      name: "test-config",
      version: 1,
      params: { chunk: { strategy: "token.recursive" } },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
  }

  function runRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "trun_1",
      tenantId: TENANT,
      configId: CONFIG_ID,
      scope: {},
      generation: "gen-1",
      status: "completed",
      rawCount: 1,
      versionCount: 1,
      error: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:01:00Z"),
      archivedLiveGeneration: null,
      archivedLiveModelKey: null,
      promotedAt: null,
      ...overrides,
    };
  }

  function unconfiguredEngineConfig(): EngineConfig {
    return {
      databaseUrl: "postgres://fake",
      dbPoolMax: 1,
      ftsLanguage: "english",
      rerank: {
        baseUrl: undefined,
        model: undefined,
        apiKey: undefined,
        maxDocChars: undefined,
        timeoutMs: undefined,
      },
    };
  }

  // No `.unsafe`/`.begin` call is valid on this path — the guard must fire
  // before either function ever reaches for the raw sql handle
  // (createRawSqlClient/resolveActiveEmbedTable, or the embed-model registry
  // a real per-row derivation would touch).
  function untouchableRawSql(): RawSql {
    return {
      unsafe: () => {
        throw new Error("rawSql.unsafe must not be called when embed is unconfigured");
      },
      begin: () => {
        throw new Error("rawSql.begin must not be called when embed is unconfigured");
      },
    } as unknown as RawSql;
  }

  // A chainable stand-in for drizzle's query/insert/update builders. Every
  // step returns a thenable; resolution is keyed on the table identity
  // passed to `.from()` (select) or directly (insert/update). `.values`/
  // `.set` record what they were called with instead of doing anything, so
  // tests can assert on the exact payload the code under test computed.
  function fakeDb(rows: {
    transformConfig?: unknown[];
    transformRun?: unknown[];
    rawCapture?: unknown[];
  }): { db: Db; updates: unknown[]; inserts: unknown[] } {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];

    function chain(table: unknown) {
      const resolve = (): Promise<unknown[]> => {
        if (table === transformConfig) return Promise.resolve(rows.transformConfig ?? []);
        if (table === transformRun) return Promise.resolve(rows.transformRun ?? []);
        if (table === rawCapture) return Promise.resolve(rows.rawCapture ?? []);
        return Promise.resolve([]);
      };
      const builder = {
        from: (t: unknown) => chain(t),
        where: () => builder,
        limit: () => builder,
        values: (v: unknown) => {
          inserts.push(v);
          return builder;
        },
        set: (v: unknown) => {
          updates.push(v);
          return builder;
        },
        then: (
          onFulfilled: (v: unknown[]) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) => resolve().then(onFulfilled, onRejected),
        catch: (onRejected: (e: unknown) => unknown) => resolve().catch(onRejected),
      };
      return builder;
    }

    const db = {
      select: () => chain(undefined),
      insert: (table: unknown) => chain(table),
      update: (table: unknown) => chain(table),
    } as unknown as Db;

    return { db, updates, inserts };
  }

  it("runTransform fails the run loudly with a clear message, never reaching per-row derivation, when no embed endpoint is configured", async () => {
    const { db, updates } = fakeDb({
      transformConfig: [configRow()],
      transformRun: [runRow({ status: "failed" })],
      // One row: if the guard were removed or moved after the per-row loop,
      // this would be picked up and attempt real derivation (which needs
      // `db.transaction`, absent from this fake) instead of failing with
      // the guard's own clear message.
      rawCapture: [{ id: "rc_1", adapter: "http", rawText: "{}" }],
    });

    const result = await runTransform(
      { db, sql: untouchableRawSql(), config: unconfiguredEngineConfig() },
      { configId: CONFIG_ID },
    );

    expect(result.status).toBe("failed");
    expect(updates).toHaveLength(1);
    const update = updates[0] as { status: string; rawCount: number; versionCount: number; error: string | null };
    expect(update.status).toBe("failed");
    expect(update.rawCount).toBe(0);
    expect(update.versionCount).toBe(0);
    expect(update.error).toContain("embed endpoint");
  });

  it("promoteGeneration rejects with a clear TransformPromoteError, never reaching the embed-model registry, when no embed endpoint is configured", async () => {
    const { db } = fakeDb({
      transformConfig: [configRow()],
      transformRun: [runRow()],
    });

    await expect(
      promoteGeneration(
        { db, sql: untouchableRawSql(), config: unconfiguredEngineConfig() },
        { tenantId: TENANT, generation: "gen-1" },
      ),
    ).rejects.toThrow(TransformPromoteError);

    await expect(
      promoteGeneration(
        { db, sql: untouchableRawSql(), config: unconfiguredEngineConfig() },
        { tenantId: TENANT, generation: "gen-1" },
      ),
    ).rejects.toThrow(/embed endpoint/);
  });
});
