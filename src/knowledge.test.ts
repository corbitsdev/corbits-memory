/**
 * Plane construction + search wiring coverage for knowledge.ts.
 *
 * - Construction: rerank maxDocChars validation runs in createKnowledgePlane.
 * - Search wiring: acl.test.ts covers blockedDocumentIds itself; the post-filter
 *   call site is pinned here so deleting or inverting it fails the suite.
 *   Uses mock.module and restores the real modules afterwards so later files
 *   keep working.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

import { RerankConfigError } from "./core/rerank-client.ts";
import type { SearchHit } from "./core/schemas/search.ts";
import { createKnowledgePlane } from "./knowledge.ts";
import type { KnowledgeConfig } from "./mount-config.ts";
import * as realDb from "./db/client.ts";
import * as realSearch from "./services/search.ts";

const PRINCIPAL = "p1";
const TENANT = "t1";

type DocAclRow = {
  id: string;
  attributes: { acl_block?: unknown };
};

/** Satisfies createFtsVerification → createRawSqlClient(sql).unsafe on the search path. */
const ENGLISH_FTS_EXPR = "to_tsvector('english'::regconfig, text)";

function hit(documentId: string): SearchHit {
  return {
    chunk_id: `chunk-${documentId}`,
    document_id: documentId,
    version: 1,
    version_id: "v1",
    status: "active",
    score: 0.9,
    title: `Doc ${documentId}`,
    snippet: "snippet",
    kind: "note",
    created_by_kind: "human",
    citation: {
      adapter: "mcp",
      external_ref: `ref-${documentId}`,
      open: { type: "doc", id: documentId },
    },
    entity_ids: [],
    channels_matched: ["lexical"],
  };
}

const wiringConfig: KnowledgeConfig = {
  knowledge: {
    databaseUrl: "postgres://localhost:5432/nonexistent-test-db",
    dbPoolMax: 1,
    ftsLanguage: "english",
    embed: {
      baseUrl: "http://embed",
      model: "m",
      apiStyle: "openai",
      apiKey: undefined,
    },
    rerank: {
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      maxDocChars: undefined,
    },
  },
};

function ftsUnsafe(sqlText: string): Promise<Array<Record<string, unknown>>> {
  if (sqlText.includes("pg_ts_config")) {
    return Promise.resolve([{ ok: 1 }]);
  }
  return Promise.resolve([{ expr: ENGLISH_FTS_EXPR }]);
}

function baseConfig(
  rerank: KnowledgeConfig["knowledge"]["rerank"],
): KnowledgeConfig {
  return {
    knowledge: {
      // Validation runs before createDb — a bad URL is fine as long as we throw
      // first and never open a connection.
      databaseUrl: "postgres://localhost:5432/nonexistent-test-db",
      dbPoolMax: 1,
      ftsLanguage: "english",
      embed: {
        baseUrl: "http://embed",
        model: "m",
        apiStyle: "openai",
        apiKey: undefined,
      },
      rerank,
    },
  };
}

describe("createKnowledgePlane — construction validation", () => {
  it("throws RerankConfigError when maxDocChars overflows a known TEI model", () => {
    // Proves validateRerankConfig runs inside createKnowledgePlane (not only
    // mountKnowledgeEngine): a standalone plane with a bad override must fail
    // construction, not silently degrade on every later search.
    expect(() =>
      createKnowledgePlane(
        baseConfig({
          baseUrl: "https://tei.example.com",
          model: "bge-reranker-base",
          apiKey: undefined,
          maxDocChars: 5_000,
        }),
      ),
    ).toThrow(RerankConfigError);
  });
});

describe("createKnowledgePlane.search — ACL post-filter wiring", () => {
  const hybridSearch = mock(() =>
    Promise.resolve({
      hits: [hit("d-blocked"), hit("d-open")],
      evidence: "strong" as const,
    }),
  );

  const sql = Object.assign(
    mock((): Promise<DocAclRow[]> =>
      Promise.resolve([
        {
          id: "d-blocked",
          attributes: { acl_block: [PRINCIPAL] },
        },
        {
          id: "d-open",
          attributes: {},
        },
      ]),
    ),
    {
      end: mock(() => Promise.resolve()),
      unsafe: mock((sqlText: string) => ftsUnsafe(sqlText)),
    },
  );

  beforeAll(() => {
    mock.module("./db/client.ts", () => ({
      ...realDb,
      createDb: () => ({ db: {}, sql }),
    }));
    mock.module("./services/search.ts", () => ({
      ...realSearch,
      hybridSearch,
    }));
  });

  afterAll(() => {
    mock.module("./db/client.ts", () => realDb);
    mock.module("./services/search.ts", () => realSearch);
  });

  it("drops hits that blockedDocumentIds withholds (call-site coverage)", async () => {
    // If knowledge.ts stops calling blockedDocumentIds (or keeps the blocked set
    // instead of filtering it out), this assertion fails.
    hybridSearch.mockClear();
    hybridSearch.mockImplementation(() =>
      Promise.resolve({
        hits: [hit("d-blocked"), hit("d-open")],
        evidence: "strong" as const,
      }),
    );
    sql.mockClear();
    sql.mockImplementation(() =>
      Promise.resolve([
        {
          id: "d-blocked",
          attributes: { acl_block: [PRINCIPAL] },
        },
        {
          id: "d-open",
          attributes: {},
        },
      ]),
    );

    const { createKnowledgePlane: makePlane } = await import(
      `./knowledge.ts?wiring-blocked=${Date.now()}`
    );
    const plane = makePlane(wiringConfig);
    const result = await plane.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
    });

    expect(hybridSearch).toHaveBeenCalled();
    expect(result.hits.map((h: SearchHit) => h.document_id)).toEqual([
      "d-open",
    ]);
    expect(result.evidence).toBe("strong");

    await plane.close();
  });

  it("withholds a hit whose acl_block is unreadable (fail-closed wiring)", async () => {
    // Non-string/non-array acl_block is the case this PR closed: the post-filter
    // must remove the hit, not pass it through.
    hybridSearch.mockClear();
    hybridSearch.mockImplementation(() =>
      Promise.resolve({
        hits: [hit("d-bad")],
        evidence: "strong" as const,
      }),
    );
    sql.mockClear();
    sql.mockImplementation(() =>
      Promise.resolve([
        {
          id: "d-bad",
          attributes: { acl_block: 42 },
        },
      ]),
    );

    const { createKnowledgePlane: makePlane } = await import(
      `./knowledge.ts?wiring-unreadable=${Date.now()}`
    );
    const plane = makePlane(wiringConfig);
    const result = await plane.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
    });

    expect(result.hits).toEqual([]);
    expect(result.evidence).toBe("none");

    await plane.close();
  });
});
