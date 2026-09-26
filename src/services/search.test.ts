import { describe, expect, it, mock } from "bun:test";
import {
  authorityWeightedScore,
  dedupeCandidatesPerDocument,
  deriveHybridEvidence,
  fetchDenseCandidates,
  hnswEfSearch,
  hybridSearch,
  snippet,
  toHit,
  type CandidateRow,
} from "./search.js";
import { memoryChunk, memoryEdge } from "../db/schema.js";
import type { Db, RawSql } from "../db/client.js";
import type { EngineConfig } from "../config.js";

function candidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    chunkId: "chunk_1",
    documentId: "doc_1",
    versionId: "ver_1",
    version: 1,
    status: "active",
    title: "Title",
    kind: "artifact",
    adapter: "artifact",
    externalRef: "artifact:1",
    createdByKind: "human",
    generatorAgentId: null,
    snippetText: "hello world",
    rank: 1,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    authority: 0.5,
    temporalClass: "event",
    validUntil: null,
    ...overrides,
  };
}

describe("authorityWeightedScore", () => {
  it("scales relevance linearly, from unchanged at 0 to +50% at 1", () => {
    const cases: Array<
      [relevance: number, authority: number, expected: number]
    > = [
      [1, 1, 1.5],
      [0.4, 0, 0.4],
      [1, 0.5, 1.25],
    ];
    for (const [relevance, authority, expected] of cases) {
      expect(authorityWeightedScore(relevance, authority)).toBeCloseTo(
        expected,
        10,
      );
    }
  });
});

describe("snippet", () => {
  it("trims, truncates with an ellipsis, and honors maxLen", () => {
    const cases: Array<
      [input: string, maxLen: number | undefined, expected: string]
    > = [
      ["hello world", undefined, "hello world"],
      ["  hello world  ", undefined, "hello world"],
      ["a".repeat(300), undefined, `${"a".repeat(240)}…`],
      ["abcdefghij", 5, "abcde…"],
    ];
    for (const [input, maxLen, expected] of cases) {
      expect(snippet(input, maxLen)).toBe(expected);
    }
  });
});

describe("dedupeCandidatesPerDocument", () => {
  it("keeps only the highest authority-weighted-scoring chunk per document", () => {
    const rows = [
      candidate({
        chunkId: "c1",
        documentId: "doc_a",
        rank: 0.5,
        authority: 0.2,
      }),
      candidate({
        chunkId: "c2",
        documentId: "doc_a",
        rank: 0.9,
        authority: 0.1,
      }),
      candidate({
        chunkId: "c3",
        documentId: "doc_b",
        rank: 0.3,
        authority: 0.9,
      }),
    ];
    const deduped = dedupeCandidatesPerDocument(rows);
    expect(deduped.map((r) => r.chunkId).sort()).toEqual(["c2", "c3"]);
  });

  it("sorts the deduped result by authority-weighted score descending", () => {
    const rows = [
      candidate({
        chunkId: "low",
        documentId: "doc_low",
        rank: 0.1,
        authority: 0,
      }),
      candidate({
        chunkId: "high",
        documentId: "doc_high",
        rank: 0.8,
        authority: 1,
      }),
    ];
    const deduped = dedupeCandidatesPerDocument(rows);
    expect(deduped[0]?.chunkId).toBe("high");
    expect(deduped[1]?.chunkId).toBe("low");
  });

  it("breaks ties in authority-weighted score by recency (most recent first)", () => {
    const rows = [
      candidate({
        chunkId: "older",
        documentId: "doc_older",
        rank: 0.5,
        authority: 0.5,
        occurredAt: new Date("2020-01-01T00:00:00Z"),
      }),
      candidate({
        chunkId: "newer",
        documentId: "doc_newer",
        rank: 0.5,
        authority: 0.5,
        occurredAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
    const deduped = dedupeCandidatesPerDocument(rows);
    expect(deduped[0]?.chunkId).toBe("newer");
    expect(deduped[1]?.chunkId).toBe("older");
  });

  it("ranks by raw fused score alone when applyAuthorityPrior is false, never double-applying authority", () => {
    const rows = [
      candidate({
        chunkId: "low-rank-high-authority",
        documentId: "doc_a",
        rank: 0.4,
        authority: 1,
      }),
      candidate({
        chunkId: "high-rank-low-authority",
        documentId: "doc_b",
        rank: 0.6,
        authority: 0,
      }),
    ];
    const deduped = dedupeCandidatesPerDocument(rows, false);
    expect(deduped[0]?.chunkId).toBe("high-rank-low-authority");
  });
});

describe("deriveHybridEvidence", () => {
  // Living relevancy (CL-5867): strong also needs the corroboration gate —
  // stated human OR supports ≥ floor. High authority alone is not enough.
  it("maps lexical/rerank signals to evidence tiers", () => {
    type Top = Parameters<typeof deriveHybridEvidence>[2];
    const cases: Array<{
      rows: CandidateRow[];
      count: number;
      top?: Top;
      expected: "strong" | "weak" | "none";
    }> = [
      {
        rows: [],
        count: 0,
        top: { rerankScore: 0.9, authority: 0.9 },
        expected: "none",
      },
      {
        rows: [candidate({ rank: 0.01, authority: 0.9 })],
        count: 1,
        expected: "weak",
      },
      {
        rows: [candidate({ rank: 0.001, authority: 0.9 })],
        count: 1,
        top: { rerankScore: 0.85, authority: 0.9, supports: 2 },
        expected: "strong",
      },
      {
        rows: [],
        count: 1,
        top: { rerankScore: 0.85, authority: 0.9, supports: 2 },
        expected: "strong",
      },
      {
        rows: [],
        count: 1,
        top: { rerankScore: 0.2, authority: 0.9, supports: 5 },
        expected: "weak",
      },
      {
        rows: [],
        count: 1,
        top: { rerankScore: 0.9, authority: 0.1, supports: 5 },
        expected: "weak",
      },
      {
        rows: [],
        count: 1,
        top: {
          rerankScore: 0.9,
          authority: 0.9,
          supports: 0,
          provenance: "inferred",
          createdByKind: "agent",
        },
        expected: "weak",
      },
      {
        rows: [],
        count: 1,
        top: {
          rerankScore: 0.85,
          authority: 0.9,
          supports: 0,
          provenance: "stated",
          createdByKind: "human",
        },
        expected: "strong",
      },
      {
        rows: [candidate({ rank: 0.9, authority: 0.9, supports: 2 })],
        count: 1,
        expected: "strong",
      },
    ];
    for (const c of cases) {
      expect(deriveHybridEvidence(c.rows, c.count, c.top)).toBe(c.expected);
    }
  });
});

describe("hnswEfSearch", () => {
  it("clamps to the product floor of 40 and the GUC max of 1000, defaulting non-finite input", () => {
    const cases: Array<[input: number, expected: number]> = [
      [0, 40],
      [1, 40],
      [40, 40],
      [250, 250],
      [1000, 1000],
      [1001, 1000],
      [Number.NaN, 40],
      [Number.POSITIVE_INFINITY, 40],
    ];
    for (const [input, expected] of cases) {
      expect(hnswEfSearch(input)).toBe(expected);
    }
  });
});

describe("fetchDenseCandidates hnsw tuning", () => {
  const MODEL_ROW = { model_key: "aaaaaaaaaaaaaaaa", model_id: "m", dims: 768 };

  function openaiEmbedFetch(): typeof fetch {
    return (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
  }

  // A fake postgres-js handle: top-level `unsafe` serves the registry
  // lookup; `begin` hands the callback a tx whose statements are recorded
  // and whose savepoint behavior is scripted per test.
  function fakeRawSql(savepointError?: Error) {
    const statements: string[] = [];
    let savepointAttempts = 0;
    type FakeTx = {
      unsafe: (sqlText: string) => Promise<unknown[]>;
      savepoint: (fn: (sp: FakeTx) => Promise<unknown>) => Promise<unknown>;
    };
    const tx: FakeTx = {
      unsafe: (sqlText: string) => {
        statements.push(sqlText);
        return Promise.resolve([]);
      },
      savepoint: (fn: (sp: FakeTx) => Promise<unknown>) => {
        savepointAttempts += 1;
        if (savepointError) return Promise.reject(savepointError);
        return fn(tx);
      },
    };
    const rawSql = {
      unsafe: (sqlText: string) => {
        statements.push(sqlText);
        return Promise.resolve(
          sqlText.includes('FROM "memory"."embed_model"') ? [MODEL_ROW] : [],
        );
      },
      begin: (cb: (t: FakeTx) => Promise<unknown>) => cb(tx),
    };
    return {
      rawSql: rawSql as unknown as Parameters<
        typeof fetchDenseCandidates
      >[0]["sql"],
      statements,
      savepointAttempts: () => savepointAttempts,
    };
  }

  function args(sql: Parameters<typeof fetchDenseCandidates>[0]["sql"]) {
    return {
      sql,
      embedClientConfig: {
        baseUrl: "https://embed.example.com",
        modelId: "m",
        apiStyle: "openai" as const,
      },
      fetchImpl: openaiEmbedFetch(),
      tenantId: "tenant-1",
      principalId: null,
      query: "hello",
      overfetchLimit: 250,
    };
  }

  it("sets ef_search from the overfetch limit and probes iterative_scan once", async () => {
    const fake = fakeRawSql();
    await fetchDenseCandidates(args(fake.rawSql));
    expect(fake.statements).toContain("SET LOCAL hnsw.ef_search = 250");
    expect(fake.statements).toContain(
      "SET LOCAL hnsw.iterative_scan = 'relaxed_order'",
    );
    expect(fake.savepointAttempts()).toBe(1);

    // Support is cached per pool: the second call sets the GUC directly
    // without another savepoint probe.
    await fetchDenseCandidates(args(fake.rawSql));
    expect(fake.savepointAttempts()).toBe(1);
    expect(
      fake.statements.filter((s) => s.includes("iterative_scan")),
    ).toHaveLength(2);
  });

  it("degrades to ef_search alone on pgvector < 0.8 and stops probing", async () => {
    const unknownGuc = Object.assign(
      new Error("unrecognized configuration parameter"),
      {
        code: "42704",
      },
    );
    const fake = fakeRawSql(unknownGuc);

    const rows = await fetchDenseCandidates(args(fake.rawSql));
    expect(rows).toEqual([]);
    expect(fake.statements).toContain("SET LOCAL hnsw.ef_search = 250");
    expect(
      fake.statements.filter((s) => s.includes("iterative_scan")),
    ).toHaveLength(0);

    await fetchDenseCandidates(args(fake.rawSql));
    expect(fake.savepointAttempts()).toBe(1);
  });

  it("rethrows a non-42704 savepoint failure", async () => {
    const fake = fakeRawSql(
      Object.assign(new Error("connection reset"), { code: "08006" }),
    );
    await expect(fetchDenseCandidates(args(fake.rawSql))).rejects.toThrow(
      "connection reset",
    );
  });
});

// Regression coverage for the fusion-bypass bug: kinds/entityIds used to be
// applied only to fetchLexicalCandidates, so a document that didn't match
// the caller's filter could still reach the caller through the dense
// channel once RRF fusion merged both result sets. This exercises
// fetchDenseCandidates directly with a fake postgres handle that behaves
// like a real one WOULD for the query fetchDenseCandidates builds: it reads
// the actual SQL text and bound params off the call and only returns rows
// that satisfy whatever kind/entity predicate is (or isn't) present. If the
// implementation stopped sending the predicate to the dense query, this
// fake would fall back to returning every row — unfiltered, exactly like a
// live Postgres would with no WHERE clause — and the assertions below
// would fail.
describe("fetchDenseCandidates kind/entity filtering", () => {
  const MODEL_ROW = { model_key: "bbbbbbbbbbbbbbbb", model_id: "m", dims: 768 };

  // Two chunks the ANN scan would surface on pure semantic similarity: one
  // belongs to a document of kind "task" linked to entity "e-match", the
  // other to kind "note" linked to no requested entity. A caller filtering
  // by kinds: ["task"] or entityIds: ["e-match"] must never see "chunk-note".
  const DENSE_ROWS: Array<Record<string, unknown>> = [
    {
      chunk_id: "chunk-task",
      document_id: "doc-task",
      version_id: "ver-task",
      version: 1,
      status: "active",
      title: "Task doc",
      kind: "task",
      adapter: "artifact",
      external_ref: "artifact:task",
      created_by_kind: "human",
      generator_agent_id: null,
      snippet_text: "matches on kind and entity",
      occurred_at: new Date("2026-01-01T00:00:00Z").toISOString(),
      authority: 0.5,
    },
    {
      chunk_id: "chunk-note",
      document_id: "doc-note",
      version_id: "ver-note",
      version: 1,
      status: "active",
      title: "Note doc",
      kind: "note",
      adapter: "artifact",
      external_ref: "artifact:note",
      created_by_kind: "human",
      generator_agent_id: null,
      snippet_text: "surfaced purely by semantic similarity",
      occurred_at: new Date("2026-01-01T00:00:00Z").toISOString(),
      authority: 0.5,
    },
  ];

  // doc-task is linked to entity "e-match"; doc-note is linked to nothing.
  const ENTITY_LINKS: Record<string, string[]> = {
    "doc-task": ["e-match"],
    "doc-note": [],
  };

  function openaiEmbedFetch(): typeof fetch {
    return (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
  }

  // Behaves like a real Postgres connection would for exactly the queries
  // fetchDenseCandidates issues: model-registry lookup, then the dense
  // SELECT itself, evaluating whatever kind/entity predicate the SQL text
  // actually contains against the canned dataset above.
  function fakeRawSql() {
    type FakeTx = {
      unsafe: (sqlText: string, params?: unknown[]) => Promise<unknown[]>;
      savepoint: (fn: (sp: FakeTx) => Promise<unknown>) => Promise<unknown>;
    };
    const statements: string[] = [];
    function evaluate(sqlText: string, params: unknown[]): unknown[] {
      let rows = DENSE_ROWS;
      const kindMatch = sqlText.match(/kd\.kind = ANY\(\$(\d+)/);
      if (kindMatch) {
        const kinds = params[Number(kindMatch[1]) - 1] as string[];
        rows = rows.filter((r) => kinds.includes(r["kind"] as string));
      }
      const entityMatch = sqlText.match(/ke\.to_ref = ANY\(\$(\d+)/);
      if (entityMatch) {
        const entityIds = params[Number(entityMatch[1]) - 1] as string[];
        rows = rows.filter((r) =>
          (ENTITY_LINKS[r["document_id"] as string] ?? []).some((e) =>
            entityIds.includes(e),
          ),
        );
      }
      return rows;
    }
    const tx: FakeTx = {
      unsafe: (sqlText: string, params: unknown[] = []) => {
        statements.push(sqlText);
        if (sqlText.includes("ORDER BY")) {
          return Promise.resolve(evaluate(sqlText, params));
        }
        return Promise.resolve([]);
      },
      savepoint: (fn: (sp: FakeTx) => Promise<unknown>) => fn(tx),
    };
    const rawSql = {
      unsafe: (sqlText: string) => {
        statements.push(sqlText);
        return Promise.resolve(
          // CL-5233 qualified the table — only the fully-qualified form matches.
          sqlText.includes('FROM "memory"."embed_model"') ? [MODEL_ROW] : [],
        );
      },
      begin: (cb: (t: FakeTx) => Promise<unknown>) => cb(tx),
    };
    return {
      rawSql: rawSql as unknown as Parameters<
        typeof fetchDenseCandidates
      >[0]["sql"],
      statements,
    };
  }

  function baseArgs(sql: Parameters<typeof fetchDenseCandidates>[0]["sql"]) {
    return {
      sql,
      embedClientConfig: {
        baseUrl: "https://embed.example.com",
        modelId: "m",
        apiStyle: "openai" as const,
      },
      fetchImpl: openaiEmbedFetch(),
      tenantId: "tenant-1",
      principalId: null,
      query: "hello",
      overfetchLimit: 250,
    };
  }

  it("excludes a semantically-similar chunk whose document kind does not match `kinds`", async () => {
    const fake = fakeRawSql();
    const rows = await fetchDenseCandidates({
      ...baseArgs(fake.rawSql),
      kinds: ["task"],
    });
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).not.toContain("chunk-note");
  });

  it("excludes a semantically-similar chunk whose document is not linked to any requested entityId", async () => {
    const fake = fakeRawSql();
    const rows = await fetchDenseCandidates({
      ...baseArgs(fake.rawSql),
      entityIds: ["e-match"],
    });
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).not.toContain("chunk-note");
  });

  it("entity filter targets memory.edge (not pre-rename knowledge_edge)", async () => {
    const fake = fakeRawSql();
    await fetchDenseCandidates({
      ...baseArgs(fake.rawSql),
      entityIds: ["e-match"],
    });
    const denseSelect = fake.statements.find(
      (s) => s.includes("ORDER BY") && s.includes("ke."),
    );
    expect(denseSelect).toBeDefined();
    expect(denseSelect).toContain('FROM "memory"."edge" ke');
    expect(denseSelect).not.toContain("knowledge_edge");
  });

  it("applies no kind/entity predicate — and returns every semantically-similar chunk — when neither filter is provided", async () => {
    const fake = fakeRawSql();
    const rows = await fetchDenseCandidates(baseArgs(fake.rawSql));
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).toContain("chunk-note");
  });

  it("treats an empty kinds/entityIds array as no filter, same as lexical", async () => {
    const fake = fakeRawSql();
    const rows = await fetchDenseCandidates({
      ...baseArgs(fake.rawSql),
      kinds: [],
      entityIds: [],
    });
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).toContain("chunk-note");
  });
});

describe("toHit — wire attribution (CL-5870)", () => {
  it("surfaces provenance, temporal, corroboration, and derived_from on the hit", () => {
    const hit = toHit(
      candidate({
        provenance: "inferred",
        sourceClass: "derived",
        temporalClass: "state",
        validUntil: new Date("2026-12-01T00:00:00Z"),
        supports: 2,
        contradicts: 0,
        derivedFrom: ["kv_source_1", "kv_source_2"],
        generatorAgentId: "resident-distiller",
        createdByKind: "agent",
      }),
    );
    expect(hit.version_id).toBe("ver_1");
    expect(hit.provenance).toBe("inferred");
    expect(hit.source_class).toBe("derived");
    expect(hit.temporal_class).toBe("state");
    expect(hit.valid_until).toBe("2026-12-01T00:00:00.000Z");
    expect(hit.supports).toBe(2);
    expect(hit.contradicts).toBe(0);
    expect(hit.derived_from).toEqual(["kv_source_1", "kv_source_2"]);
    expect(hit.generator_agent_id).toBe("resident-distiller");
    expect(hit.created_by_kind).toBe("agent");
  });

  it("omits optional attribution fields when absent (additive wire)", () => {
    const hit = toHit(candidate());
    expect(hit.provenance).toBeUndefined();
    expect(hit.source_class).toBeUndefined();
    expect(hit.derived_from).toBeUndefined();
    expect(hit.generator_agent_id).toBeUndefined();
    expect(hit.supports).toBe(0);
    expect(hit.contradicts).toBe(0);
    expect(hit.temporal_class).toBe("event");
  });

  it("distinguishes stated human vs inferred agent attribution shapes", () => {
    const human = toHit(
      candidate({
        provenance: "stated",
        sourceClass: "native",
        createdByKind: "human",
        generatorAgentId: null,
      }),
    );
    const distilled = toHit(
      candidate({
        provenance: "inferred",
        sourceClass: "derived",
        createdByKind: "agent",
        generatorAgentId: "resident-distiller",
        derivedFrom: ["kv_raw"],
      }),
    );
    expect(human.provenance).toBe("stated");
    expect(human.created_by_kind).toBe("human");
    expect(human.generator_agent_id).toBeUndefined();
    expect(distilled.provenance).toBe("inferred");
    expect(distilled.created_by_kind).toBe("agent");
    expect(distilled.generator_agent_id).toBe("resident-distiller");
    expect(distilled.derived_from).toEqual(["kv_raw"]);
  });
});

// CL-6287: hybridSearch must construct and serve lexical results when the
// engine has no embed endpoint configured (EngineConfig.embed absent) —
// dense retrieval SKIPPED rather than attempted-and-failed. A minimal
// drizzle-shaped `Db` fake stands in for the lexical query + the
// attach*/entity-id follow-up queries, all of which return camelCase rows
// shaped exactly like a real query's aliased columns (CandidateRow already
// is that shape) so no real drizzle execution is needed. `rawSql` is a stub
// that throws if touched at all — proof that the embed-model registry
// (which only ever reaches Postgres through `createRawSqlClient(rawSql)`,
// see embed-sql.ts) is never consulted on this path.
describe("hybridSearch — embed unconfigured (CL-6287)", () => {
  // A chainable stand-in for drizzle's query builder. Every step returns a
  // thenable so `await db.select(...).from(t)...limit(n)` and
  // `await db.select(...).from(t).where(...)` (the attach*/entity-id
  // queries, which never call .limit) both resolve correctly regardless of
  // how many chain steps run after `.from()`. Resolution is keyed on the
  // table passed to `.from()` — the only piece of the call these
  // functions' return value actually depends on for this test.
  function fakeDb(lexicalRows: unknown[]): Db {
    function chain(table: unknown) {
      const rows = (): Promise<unknown[]> => {
        if (table === memoryChunk) return Promise.resolve(lexicalRows);
        if (table === memoryEdge) return Promise.resolve([]);
        return Promise.resolve([]);
      };
      const builder = {
        from: (t: unknown) => chain(t),
        innerJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        // oxlint-disable-next-line unicorn/no-thenable -- fakes drizzle's thenable query builder
        then: (
          onFulfilled: (v: unknown[]) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) => rows().then(onFulfilled, onRejected),
        catch: (onRejected: (e: unknown) => unknown) =>
          rows().catch(onRejected),
      };
      return builder;
    }
    return { select: () => chain(undefined) } as unknown as Db;
  }

  // No `.unsafe`/`.begin` call is valid on this path — dense retrieval must
  // never be attempted, so nothing should ever reach for the raw sql handle
  // (fetchDenseCandidates, the embed-model registry probe/activation, and
  // fetchChunkVectors' MMR lookup all go through it).
  function untouchableRawSql(): RawSql {
    return {
      unsafe: () => {
        throw new Error(
          "rawSql.unsafe must not be called when embed is unconfigured",
        );
      },
      begin: () => {
        throw new Error(
          "rawSql.begin must not be called when embed is unconfigured",
        );
      },
    } as unknown as RawSql;
  }

  function unconfiguredEmbedConfig(): EngineConfig {
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

  // The no-embed lexical dispatch itself is covered end to end by tests/;
  // what stays here is the degraded-flag contract (configured-off reads
  // differently from a runtime failure).
  it("reports dense_unavailable and lexical_only together, distinguishing configured-off from a runtime failure", async () => {
    const result = await hybridSearch(
      {
        db: fakeDb([candidate()]),
        sql: untouchableRawSql(),
        config: unconfiguredEmbedConfig(),
        fetchImpl: mock(() =>
          Promise.reject(new Error("unreachable")),
        ) as unknown as typeof fetch,
      },
      { query: "hello", tenantId: "tenant-1", principalId: null },
    );

    expect(result.degraded).toContain("dense_unavailable");
    expect(result.degraded).toContain("lexical_only");
  });

  it("returns lexical results without ever calling the embed endpoint", async () => {
    const lexicalRow = candidate({
      chunkId: "chunk_lexical",
      documentId: "doc_lexical",
      title: "Q3 roadmap notes",
      snippetText: "west coast expansion roadmap",
      rank: 0.8,
    });
    const fetchImpl = mock(() =>
      Promise.reject(
        new Error("fetch must not be called when embed is unconfigured"),
      ),
    );

    const result = await hybridSearch(
      {
        db: fakeDb([lexicalRow]),
        sql: untouchableRawSql(),
        config: unconfiguredEmbedConfig(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: new Date("2026-01-01T00:00:00Z"),
      },
      { query: "roadmap", tenantId: "tenant-1", principalId: null },
    );

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.chunk_id).toBe("chunk_lexical");
    expect(result.hits[0]?.channels_matched).toEqual(["lexical"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
