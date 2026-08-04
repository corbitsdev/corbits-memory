import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  authorityWeightedScore,
  dedupeCandidatesPerDocument,
  deriveHybridEvidence,
  fetchDenseCandidates,
  hnswEfSearch,
  snippet,
  visibilityPredicateSql,
  visibilityPredicateRawSql,
  VISIBILITY_PREDICATE_RAW_SQL,
  VISIBILITY_PREDICATE_RAW_SQL_NULL_PRINCIPAL,
  type CandidateRow,
} from "./search.ts";

const dialect = new PgDialect();

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
    ...overrides,
  };
}

describe("visibilityPredicateSql", () => {
  it("scopes 'principals'/'private' docs to a JSON array containing the given principal id", () => {
    const { sql, params } = dialect.sqlToQuery(visibilityPredicateSql("principal_a"));
    expect(sql).toContain("visibility_mode");
    expect(sql).toContain("'tenant'");
    expect(sql).toContain("'principals', 'private'");
    expect(params).toContain(JSON.stringify(["principal_a"]));
  });

  it("never matches a 'principals'/'private' doc when principalId is null — returns a tenant-only predicate with NO principal_ids check at all", () => {
    const { sql, params } = dialect.sqlToQuery(visibilityPredicateSql(null));
    // Regression guard: a null principal must NOT be modeled as "matches an
    // empty principal_ids array" — jsonb `@>` containment treats the empty
    // array as a subset of EVERY array (`'["x"]'::jsonb @> '[]'::jsonb` is
    // TRUE), so that shape would vacuously match any 'principals'/'private'
    // doc regardless of its actual principal_ids. The null-principal
    // predicate is instead the plain, unconditional 'tenant' check — no
    // principal_ids column reference, no jsonb params, at all.
    expect(sql).toContain("visibility_mode");
    expect(sql).toContain("'tenant'");
    expect(sql).not.toContain("principal_ids");
    expect(sql).not.toContain("'principals', 'private'");
    expect(params).toEqual([]);
  });

  it("produces the identical predicate shape as the raw-SQL string used by the dense channel, for BOTH the with-principal and null-principal cases", () => {
    function normalize(rawSql: string): string {
      return rawSql
        .replace(/"knowledge"\."document"\./g, "kd.")
        .replace(/"knowledge_document"\./g, "kd.")
        .replace(/"(\w+)"/g, "$1")
        .replace(/\$\d+/g, "$PARAM")
        .replace(/\s+/g, " ")
        .trim();
    }

    const withPrincipal = dialect.sqlToQuery(visibilityPredicateSql("principal_a"));
    const normalizedRawWithPrincipal = VISIBILITY_PREDICATE_RAW_SQL.replace(
      "$VISIBILITY_PRINCIPAL_JSON",
      "$PARAM",
    )
      .replace(/\s+/g, " ")
      .trim();
    expect(normalize(withPrincipal.sql)).toBe(normalizedRawWithPrincipal);
    expect(visibilityPredicateRawSql(true)).toBe(VISIBILITY_PREDICATE_RAW_SQL);

    const nullPrincipal = dialect.sqlToQuery(visibilityPredicateSql(null));
    const normalizedRawNullPrincipal = VISIBILITY_PREDICATE_RAW_SQL_NULL_PRINCIPAL.replace(
      /\s+/g,
      " ",
    ).trim();
    expect(normalize(nullPrincipal.sql)).toBe(normalizedRawNullPrincipal);
    expect(visibilityPredicateRawSql(false)).toBe(
      VISIBILITY_PREDICATE_RAW_SQL_NULL_PRINCIPAL,
    );
  });
});

describe("authorityWeightedScore", () => {
  it("boosts a relevance score by up to 50% at authority === 1", () => {
    expect(authorityWeightedScore(1, 1)).toBeCloseTo(1.5, 10);
  });

  it("leaves the relevance score unchanged at authority === 0", () => {
    expect(authorityWeightedScore(0.4, 0)).toBeCloseTo(0.4, 10);
  });

  it("scales linearly with authority in between", () => {
    expect(authorityWeightedScore(1, 0.5)).toBeCloseTo(1.25, 10);
  });
});

describe("snippet", () => {
  it("returns short text unchanged", () => {
    expect(snippet("hello world")).toBe("hello world");
  });

  it("trims surrounding whitespace", () => {
    expect(snippet("  hello world  ")).toBe("hello world");
  });

  it("truncates long text to maxLen and appends an ellipsis", () => {
    const long = "a".repeat(300);
    const result = snippet(long);
    expect(result.length).toBe(241);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("a".repeat(240))).toBe(true);
  });

  it("respects a custom maxLen", () => {
    const result = snippet("abcdefghij", 5);
    expect(result).toBe("abcde…");
  });
});

describe("dedupeCandidatesPerDocument", () => {
  it("keeps only the highest authority-weighted-scoring chunk per document", () => {
    const rows = [
      candidate({ chunkId: "c1", documentId: "doc_a", rank: 0.5, authority: 0.2 }),
      candidate({ chunkId: "c2", documentId: "doc_a", rank: 0.9, authority: 0.1 }),
      candidate({ chunkId: "c3", documentId: "doc_b", rank: 0.3, authority: 0.9 }),
    ];
    const deduped = dedupeCandidatesPerDocument(rows);
    expect(deduped.map((r) => r.chunkId).sort()).toEqual(["c2", "c3"]);
  });

  it("sorts the deduped result by authority-weighted score descending", () => {
    const rows = [
      candidate({ chunkId: "low", documentId: "doc_low", rank: 0.1, authority: 0 }),
      candidate({ chunkId: "high", documentId: "doc_high", rank: 0.8, authority: 1 }),
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
      candidate({ chunkId: "low-rank-high-authority", documentId: "doc_a", rank: 0.4, authority: 1 }),
      candidate({ chunkId: "high-rank-low-authority", documentId: "doc_b", rank: 0.6, authority: 0 }),
    ];
    const deduped = dedupeCandidatesPerDocument(rows, false);
    expect(deduped[0]?.chunkId).toBe("high-rank-low-authority");
  });
});

describe("deriveHybridEvidence", () => {
  it("reports 'none' on zero hits regardless of a reranked top hit", () => {
    expect(
      deriveHybridEvidence([], 0, { rerankScore: 0.9, authority: 0.9 }),
    ).toBe("none");
  });

  it("reports 'weak' via the lexical path when there is no reranked top hit and lexical ts_rank is low", () => {
    const lexicalRows = [candidate({ rank: 0.01, authority: 0.9 })];
    expect(deriveHybridEvidence(lexicalRows, 1)).toBe("weak");
  });

  // The bug this fix closes: a query resolved mostly through the DENSE
  // channel has a low (or zero) lexical ts_rank, so before this fix
  // deriveHybridEvidence always fell through to deriveEvidence(lexicalRows)
  // and reported "weak" — even when the cross-encoder rerank was highly
  // confident and authority was high. The reranked-path floor now reports
  // "strong" in that case instead.
  it("reports 'strong' when reranked + high rerank score + high authority, even though lexical ts_rank is low", () => {
    const lowLexicalRows = [candidate({ rank: 0.001, authority: 0.9 })];
    const evidence = deriveHybridEvidence(lowLexicalRows, 1, {
      rerankScore: 0.85,
      authority: 0.9,
    });
    expect(evidence).toBe("strong");
  });

  it("reports 'strong' even with NO lexical rows at all, given a confident reranked top hit", () => {
    const evidence = deriveHybridEvidence([], 1, {
      rerankScore: 0.85,
      authority: 0.9,
    });
    expect(evidence).toBe("strong");
  });

  it("reports 'weak' when the reranked top hit's rerank score is below the strong floor", () => {
    const evidence = deriveHybridEvidence([], 1, {
      rerankScore: 0.2,
      authority: 0.9,
    });
    expect(evidence).toBe("weak");
  });

  it("reports 'weak' when the reranked top hit clears the rerank floor but authority is low", () => {
    const evidence = deriveHybridEvidence([], 1, {
      rerankScore: 0.9,
      authority: 0.1,
    });
    expect(evidence).toBe("weak");
  });

  it("falls back to the lexical evidence path when reranking did not run (no rerankedTop)", () => {
    const strongLexicalRows = [candidate({ rank: 0.9, authority: 0.9 })];
    expect(deriveHybridEvidence(strongLexicalRows, 1)).toBe("strong");
  });
});

describe("hnswEfSearch", () => {
  it("clamps to the product floor of 40 and the GUC max of 1000", () => {
    expect(hnswEfSearch(0)).toBe(40);
    expect(hnswEfSearch(1)).toBe(40);
    expect(hnswEfSearch(40)).toBe(40);
    expect(hnswEfSearch(250)).toBe(250);
    expect(hnswEfSearch(1000)).toBe(1000);
    expect(hnswEfSearch(1001)).toBe(1000);
  });

  it("falls back to the default for non-finite input", () => {
    expect(hnswEfSearch(Number.NaN)).toBe(40);
    expect(hnswEfSearch(Number.POSITIVE_INFINITY)).toBe(40);
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
          sqlText.includes('FROM "knowledge"."embed_model"') ||
            sqlText.includes("FROM knowledge_embed_model")
            ? [MODEL_ROW]
            : [],
        );
      },
      begin: (cb: (t: FakeTx) => Promise<unknown>) => cb(tx),
    };
    return {
      rawSql: rawSql as unknown as Parameters<typeof fetchDenseCandidates>[0]["sql"],
      statements,
      savepointAttempts: () => savepointAttempts,
    };
  }

  function args(sql: Parameters<typeof fetchDenseCandidates>[0]["sql"]) {
    return {
      sql,
      embedClientConfig: { baseUrl: "https://embed.example.com", modelId: "m", apiStyle: "openai" as const },
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
    expect(fake.statements).toContain("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
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
    const unknownGuc = Object.assign(new Error("unrecognized configuration parameter"), {
      code: "42704",
    });
    const fake = fakeRawSql(unknownGuc);

    const rows = await fetchDenseCandidates(args(fake.rawSql));
    expect(rows).toEqual([]);
    expect(fake.statements).toContain("SET LOCAL hnsw.ef_search = 250");
    expect(fake.statements.filter((s) => s.includes("iterative_scan"))).toHaveLength(0);

    await fetchDenseCandidates(args(fake.rawSql));
    expect(fake.savepointAttempts()).toBe(1);
  });

  it("rethrows a non-42704 savepoint failure", async () => {
    const fake = fakeRawSql(Object.assign(new Error("connection reset"), { code: "08006" }));
    await expect(fetchDenseCandidates(args(fake.rawSql))).rejects.toThrow("connection reset");
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
        if (sqlText.includes("ORDER BY")) {
          return Promise.resolve(evaluate(sqlText, params));
        }
        return Promise.resolve([]);
      },
      savepoint: (fn: (sp: FakeTx) => Promise<unknown>) => fn(tx),
    };
    const rawSql = {
      unsafe: (sqlText: string) =>
        Promise.resolve(
          // CL-5233 qualified the table; keep the pre-qualify form so an
          // accidental revert still fails this suite the same way.
          sqlText.includes('FROM "knowledge"."embed_model"') ||
            sqlText.includes("FROM knowledge_embed_model")
            ? [MODEL_ROW]
            : [],
        ),
      begin: (cb: (t: FakeTx) => Promise<unknown>) => cb(tx),
    };
    return rawSql as unknown as Parameters<typeof fetchDenseCandidates>[0]["sql"];
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
    const rows = await fetchDenseCandidates({
      ...baseArgs(fakeRawSql()),
      kinds: ["task"],
    });
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).not.toContain("chunk-note");
  });

  it("excludes a semantically-similar chunk whose document is not linked to any requested entityId", async () => {
    const rows = await fetchDenseCandidates({
      ...baseArgs(fakeRawSql()),
      entityIds: ["e-match"],
    });
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).not.toContain("chunk-note");
  });

  it("applies no kind/entity predicate — and returns every semantically-similar chunk — when neither filter is provided", async () => {
    const rows = await fetchDenseCandidates(baseArgs(fakeRawSql()));
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).toContain("chunk-note");
  });

  it("treats an empty kinds/entityIds array as no filter, same as lexical", async () => {
    const rows = await fetchDenseCandidates({
      ...baseArgs(fakeRawSql()),
      kinds: [],
      entityIds: [],
    });
    const chunkIds = rows?.map((r) => r.chunkId) ?? [];
    expect(chunkIds).toContain("chunk-task");
    expect(chunkIds).toContain("chunk-note");
  });
});
