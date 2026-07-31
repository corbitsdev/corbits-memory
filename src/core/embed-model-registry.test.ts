import { describe, expect, it, mock } from "bun:test";
import type { EmbedClientConfig } from "./embed-client.ts";
import {
  activateEmbedModel,
  computeModelKey,
  cosineDistanceExpr,
  DimsOutOfBoundsError,
  discoverModelDims,
  EMBED_TABLE_NAME_PATTERN,
  embeddingTableName,
  type EmbedRegistrySqlClient,
  HALFVEC_INDEX_MAX_DIMS,
  resolveActiveEmbedTable,
  VECTOR_INDEX_MAX_DIMS,
} from "./embed-model-registry.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch(dims: number): typeof fetch {
  return mock(() =>
    Promise.resolve(jsonResponse({ data: [{ embedding: new Array(dims).fill(0.1) }] })),
  ) as unknown as typeof fetch;
}

const baseConfig: EmbedClientConfig = {
  baseUrl: "https://api.example.com",
  modelId: "text-embed-3",
  apiStyle: "openai",
};

function createMockClient(): { client: EmbedRegistrySqlClient; queries: Array<{ sql: string; params: readonly unknown[] }> } {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client: EmbedRegistrySqlClient = {
    query: (sql, params) => {
      queries.push({ sql, params });
      return Promise.resolve([]);
    },
  };
  return { client, queries };
}

describe("computeModelKey / embeddingTableName", () => {
  it("is deterministic for the same (baseUrl, modelId)", () => {
    const a = computeModelKey("https://api.example.com", "model-a");
    const b = computeModelKey("https://api.example.com", "model-a");
    expect(a).toBe(b);
  });

  it("differs across baseUrl or modelId", () => {
    const a = computeModelKey("https://api.example.com", "model-a");
    const b = computeModelKey("https://api.example.com", "model-b");
    const c = computeModelKey("https://other.example.com", "model-a");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("produces a table name matching the identifier-validation pattern", () => {
    const key = computeModelKey("https://api.example.com", "model-a");
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    const tableName = embeddingTableName(key);
    expect(tableName).toMatch(EMBED_TABLE_NAME_PATTERN);
    expect(tableName).toBe(`knowledge_embedding_${key}`);
  });

  it("rejects a key that would produce an invalid identifier", () => {
    expect(() => embeddingTableName("not-hex!!")).toThrow();
  });
});

describe("discoverModelDims", () => {
  it("returns dims within bounds (T2/T3 style fixtures)", async () => {
    expect(await discoverModelDims(baseConfig, fixtureFetch(768))).toBe(768);
    expect(await discoverModelDims(baseConfig, fixtureFetch(1024))).toBe(1024);
  });

  it("refuses a too-small probe result (T6)", async () => {
    await expect(discoverModelDims(baseConfig, fixtureFetch(32))).rejects.toThrow(
      DimsOutOfBoundsError,
    );
  });

  it("refuses a too-large probe result (T6)", async () => {
    await expect(discoverModelDims(baseConfig, fixtureFetch(5000))).rejects.toThrow(
      DimsOutOfBoundsError,
    );
  });

  it("accepts the halfvec cap exactly and rejects one past it", async () => {
    expect(await discoverModelDims(baseConfig, fixtureFetch(HALFVEC_INDEX_MAX_DIMS))).toBe(
      HALFVEC_INDEX_MAX_DIMS,
    );
    await expect(
      discoverModelDims(baseConfig, fixtureFetch(HALFVEC_INDEX_MAX_DIMS + 1)),
    ).rejects.toThrow(DimsOutOfBoundsError);
  });
});

describe("cosineDistanceExpr", () => {
  it("emits the plain vector expression up to the vector index cap", () => {
    expect(cosineDistanceExpr("e.embedding", "$3", VECTOR_INDEX_MAX_DIMS)).toBe(
      "e.embedding <=> $3::vector",
    );
  });

  it("emits the halfvec expression past the vector index cap", () => {
    expect(cosineDistanceExpr("e.embedding", "$3", VECTOR_INDEX_MAX_DIMS + 1)).toBe(
      `(e.embedding::halfvec(${VECTOR_INDEX_MAX_DIMS + 1})) <=> $3::halfvec(${VECTOR_INDEX_MAX_DIMS + 1})`,
    );
  });

  it("rejects non-positive or non-integer dims", () => {
    expect(() => cosineDistanceExpr("e.embedding", "$1", 0)).toThrow();
    expect(() => cosineDistanceExpr("e.embedding", "$1", -5)).toThrow();
    expect(() => cosineDistanceExpr("e.embedding", "$1", 768.5)).toThrow();
  });
});

describe("activateEmbedModel", () => {
  it("upserts the registry row and creates the per-model table + hnsw index (T2)", async () => {
    const { client, queries } = createMockClient();
    const result = await activateEmbedModel(
      client,
      "tenant-1",
      baseConfig,
      fixtureFetch(768),
    );

    expect(result.dims).toBe(768);
    expect(result.tableName).toMatch(EMBED_TABLE_NAME_PATTERN);

    const insertQuery = queries.find((q) => q.sql.includes("INSERT INTO knowledge_embed_model"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery?.params).toContain("tenant-1");
    expect(insertQuery?.params).toContain(768);

    const createTableQuery = queries.find((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS"));
    expect(createTableQuery?.sql).toContain(result.tableName);
    expect(createTableQuery?.sql).toContain("vector(768)");

    const indexQuery = queries.find((q) => q.sql.includes("CREATE INDEX"));
    expect(indexQuery?.sql).toContain("USING hnsw");
  });

  it("falls back to ivfflat when hnsw creation fails", async () => {
    const queries: Array<{ sql: string }> = [];
    const client: EmbedRegistrySqlClient = {
      query: (sql) => {
        queries.push({ sql });
        if (sql.includes("USING hnsw")) {
          return Promise.reject(new Error("hnsw access method does not exist"));
        }
        return Promise.resolve([]);
      },
    };

    await activateEmbedModel(client, "tenant-1", baseConfig, fixtureFetch(768));

    expect(queries.some((q) => q.sql.includes("USING hnsw"))).toBe(true);
    expect(queries.some((q) => q.sql.includes("USING ivfflat"))).toBe(true);
  });

  it("is idempotent — calling twice with identical config computes the same table name (T5)", async () => {
    const { client, queries } = createMockClient();
    const first = await activateEmbedModel(client, "tenant-1", baseConfig, fixtureFetch(768));
    const second = await activateEmbedModel(client, "tenant-1", baseConfig, fixtureFetch(768));

    expect(first.tableName).toBe(second.tableName);
    expect(first.modelKey).toBe(second.modelKey);

    const createTableQueries = queries.filter((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS"));
    expect(createTableQueries).toHaveLength(2);
    expect(createTableQueries[0]?.sql).toBe(createTableQueries[1]?.sql);
  });

  it("creates a halfvec expression hnsw index past the vector cap, matching the query expression", async () => {
    const dims = 3072;
    const { client, queries } = createMockClient();
    const result = await activateEmbedModel(client, "tenant-1", baseConfig, fixtureFetch(dims));

    expect(result.dims).toBe(dims);
    const indexQuery = queries.find((q) => q.sql.includes("CREATE INDEX"));
    expect(indexQuery?.sql).toContain("USING hnsw");
    expect(indexQuery?.sql).toContain("halfvec_cosine_ops");
    expect(indexQuery?.sql).not.toContain("ivfflat");

    // The planner only uses an expression index when the query reproduces
    // the indexed expression. DDL indexes bare `embedding`; production dense
    // search (search.ts) passes the table-qualified alias `e.embedding` —
    // pin the query identity the live path actually emits.
    expect(indexQuery?.sql).toContain(
      `((embedding::halfvec(${dims})) halfvec_cosine_ops)`,
    );
    expect(cosineDistanceExpr("e.embedding", "$1", dims)).toBe(
      `(e.embedding::halfvec(${dims})) <=> $1::halfvec(${dims})`,
    );
  });

  it("does not fall back to ivfflat when halfvec index creation fails", async () => {
    const client: EmbedRegistrySqlClient = {
      query: (sql) =>
        sql.includes("USING hnsw")
          ? Promise.reject(new Error("type halfvec does not exist"))
          : Promise.resolve([]),
    };

    await expect(
      activateEmbedModel(client, "tenant-1", baseConfig, fixtureFetch(2500)),
    ).rejects.toThrow("halfvec does not exist");
  });

  it("lets two different models coexist under different table names (T3 — 768d + 1024d)", async () => {
    const { client } = createMockClient();
    const modelA = await activateEmbedModel(
      client,
      "tenant-1",
      { ...baseConfig, modelId: "model-a" },
      fixtureFetch(768),
    );
    const modelB = await activateEmbedModel(
      client,
      "tenant-1",
      { ...baseConfig, modelId: "model-b" },
      fixtureFetch(1024),
    );

    expect(modelA.tableName).not.toBe(modelB.tableName);
    expect(modelA.dims).toBe(768);
    expect(modelB.dims).toBe(1024);
  });
});

describe("resolveActiveEmbedTable", () => {
  it("returns null when no active model is configured for the tenant", async () => {
    const client: EmbedRegistrySqlClient = { query: () => Promise.resolve([]) };
    expect(await resolveActiveEmbedTable(client, "tenant-1")).toBeNull();
  });

  it("returns the active table info when a row exists", async () => {
    const modelKey = computeModelKey(baseConfig.baseUrl, baseConfig.modelId);
    const client: EmbedRegistrySqlClient = {
      query: () =>
        Promise.resolve([{ model_key: modelKey, model_id: baseConfig.modelId, dims: 768 }]),
    };
    const result = await resolveActiveEmbedTable(client, "tenant-1");
    expect(result).toEqual({
      tableName: `knowledge_embedding_${modelKey}`,
      dims: 768,
      modelId: baseConfig.modelId,
    });
  });
});
