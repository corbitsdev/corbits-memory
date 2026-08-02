/**
 * Plane construction, ACL wiring, and ask() coverage for knowledge.ts.
 *
 * - Construction: rerank maxDocChars validation runs in createKnowledgePlane.
 * - Search wiring: acl.test.ts covers blockedDocumentIds itself; the post-filter
 *   call site is pinned here so deleting or inverting it fails the suite.
 * - ask(): grant check, missing generate (501 before search), allow path,
 *   synthesizeAnswer grounding.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";

import { RerankConfigError } from "./core/rerank-client.ts";
import type { SearchHit } from "./core/schemas/search.ts";
import {
  createKnowledgePlane,
  KnowledgeError,
  KnowledgeNotPermittedError,
  synthesizeAnswer,
  type ChatMessage,
} from "./knowledge.ts";
import type { KnowledgeConfig } from "./mount-config.ts";
import * as realDb from "./db/client.ts";
import * as realSearch from "./services/search.ts";
import type { HybridSearchResult } from "./services/search.ts";

const PRINCIPAL = "p1";
const TENANT = "t1";

type DocAclRow = {
  id: string;
  attributes: { acl_block?: unknown };
};

/** Satisfies createFtsVerification → createRawSqlClient(sql).unsafe on the search path. */
const ENGLISH_FTS_EXPR = "to_tsvector('english'::regconfig, text)";

function grant(action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "knowledge",
    action,
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: PRINCIPAL,
  };
}

function hit(overrides: Partial<SearchHit> | string = {}): SearchHit {
  if (typeof overrides === "string") {
    const documentId = overrides;
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
  return {
    chunk_id: "chunk-1",
    document_id: "doc-1",
    version: 1,
    version_id: "v1",
    status: "active",
    score: 0.9,
    title: "Doc One",
    snippet: "the relevant snippet",
    kind: "note",
    created_by_kind: "human",
    citation: {
      adapter: "mcp",
      external_ref: "ref-1",
      open: { type: "doc", id: "doc-1" },
    },
    entity_ids: [],
    channels_matched: ["lexical"],
    ...overrides,
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

const askConfig: KnowledgeConfig = wiringConfig;

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
  const hybridSearch = mock((): Promise<HybridSearchResult> =>
    Promise.resolve({
      hits: [hit("d-blocked"), hit("d-open")],
      evidence: "strong",
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

  it("threads kinds and entityIds through to hybridSearch", async () => {
    // Regression guard for CL-5021: the plane must pass kinds/entityIds
    // straight through to the service that already supports them, not
    // silently drop them.
    hybridSearch.mockClear();
    hybridSearch.mockImplementation(() =>
      Promise.resolve({ hits: [], evidence: "none" as const }),
    );
    sql.mockClear();

    const { createKnowledgePlane: makePlane } = await import(
      `./knowledge.ts?wiring-kinds=${Date.now()}`
    );
    const plane = makePlane(wiringConfig);
    await plane.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
      kinds: ["artifact", "task"],
      entityIds: ["e1"],
    });

    expect(hybridSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kinds: ["artifact", "task"],
        entityIds: ["e1"],
      }),
    );

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

describe("ask() — grant check", () => {
  it("denies with KnowledgeNotPermittedError when no grant matches (effect: null)", async () => {
    const grants = {
      grantStore: createInMemoryGrantStore([]),
      conditionRegistry: {},
    };
    const plane = createKnowledgePlane(askConfig, grants);
    await expect(
      plane.ask({ tenantId: TENANT, principalId: PRINCIPAL, query: "q" }),
    ).rejects.toBeInstanceOf(KnowledgeNotPermittedError);
  });

  it("denies when the only matching grant is an explicit deny", async () => {
    const denyGrant: GrantRule = { ...grant("search"), effect: "deny" };
    const grants = {
      grantStore: createInMemoryGrantStore([denyGrant]),
      conditionRegistry: {},
    };
    const plane = createKnowledgePlane(askConfig, grants);
    await expect(
      plane.ask({ tenantId: TENANT, principalId: PRINCIPAL, query: "q" }),
    ).rejects.toBeInstanceOf(KnowledgeNotPermittedError);
  });
});

describe("ask() — missing generate", () => {
  it("throws KnowledgeError 501 before search when generate is not wired", async () => {
    // Pointed at a nonexistent DB: if search ran first this would surface a
    // connection/driver error instead of the promised 501.
    const grants = {
      grantStore: createInMemoryGrantStore([grant("search")]),
      conditionRegistry: {},
    };
const plane = createKnowledgePlane(askConfig, grants);
    try {
      await plane.ask({ tenantId: TENANT, principalId: PRINCIPAL, query: "q" });
      throw new Error("expected ask() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).status).toBe(501);
      expect((err as KnowledgeError).message).toContain("generate");
    }
  });
});

describe("ask() — allow path", () => {
  it("searches as the principal and synthesizes when grant allows and generate is wired", async () => {
    const grants = {
      grantStore: createInMemoryGrantStore([grant("search")]),
      conditionRegistry: {},
    };
    const generate = mock((messages: readonly ChatMessage[]) => {
      expect(messages[0]?.role).toBe("system");
      expect(messages[1]?.content).toContain("what is the answer?");
      expect(messages[1]?.content).toContain("[1] Doc One");
      expect(messages[1]?.content).toContain("the relevant snippet");
      return Promise.resolve("Answer from context [1].");
    });
const plane = createKnowledgePlane(askConfig, grants, { generate });
    // Stub search so this unit test never needs a live Postgres. ask() looks
    // up plane.search at call time, so reassignment is the wiring under test.
    plane.search = mock(() =>
      Promise.resolve({ hits: [hit()], evidence: "strong" as const }),
    );

    const result = await plane.ask({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "what is the answer?",
    });

    expect(plane.search).toHaveBeenCalledWith({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "what is the answer?",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Answer from context [1].");
    expect(result.evidence).toBe("strong");
    expect(result.citations).toEqual([
      {
        index: 1,
        documentId: "doc-1",
        title: "Doc One",
        citation: hit().citation,
      },
    ]);
  });
});

describe("synthesizeAnswer", () => {
  const neverCalled = mock(() =>
    Promise.reject(new Error("generate must not be called")),
  );

  it("refuses with no citations when there are no hits", async () => {
    const result = await synthesizeAnswer(
      "q",
      { hits: [], evidence: "none" },
      neverCalled,
    );
    expect(result.citations).toEqual([]);
    expect(result.evidence).toBe("none");
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("refuses with no citations when hits have no readable snippet text", async () => {
    const result = await synthesizeAnswer(
      "q",
      { hits: [hit({ snippet: "   " })], evidence: "weak" },
      neverCalled,
    );
    expect(result.text).toContain("couldn't read any text");
    expect(result.citations).toEqual([]);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("grounds the prompt in the retrieved snippets and returns their citations", async () => {
    const generate = mock((messages: readonly ChatMessage[]) => {
      // The grounding contract: the model sees the numbered context, and only
      // the numbered context, for the hits that fit the budget.
      expect(messages[1]?.content).toContain("[1] Doc One");
      expect(messages[1]?.content).toContain("the relevant snippet");
      return Promise.resolve("Grounded answer [1].");
    });

    const result = await synthesizeAnswer(
      "what is the answer?",
      { hits: [hit()], evidence: "strong" },
      generate,
    );

    expect(result.text).toBe("Grounded answer [1].");
    expect(result.evidence).toBe("strong");
    expect(result.citations).toEqual([
      {
        index: 1,
        documentId: "doc-1",
        title: "Doc One",
        citation: hit().citation,
      },
    ]);
  });

  it("numbers citations sequentially among included entries, skipping empty snippets", async () => {
    const generate = mock((messages: readonly ChatMessage[]) => {
      const content = messages[1]?.content ?? "";
      // First hit is empty → skipped; second becomes [1], not [2].
      expect(content).toContain("[1] Real Doc");
      expect(content).toContain("actual content");
      expect(content).not.toContain("[2]");
      expect(content).not.toContain("Empty Doc");
      return Promise.resolve("From [1].");
    });

    const result = await synthesizeAnswer(
      "q",
      {
        hits: [
          hit({ title: "Empty Doc", snippet: "   " }),
          hit({
            title: "Real Doc",
            snippet: "actual content",
            document_id: "doc-2",
            chunk_id: "chunk-2",
          }),
        ],
        evidence: "weak",
      },
      generate,
    );

    expect(result.citations).toEqual([
      {
        index: 1,
        documentId: "doc-2",
        title: "Real Doc",
        citation: hit().citation,
      },
    ]);
  });

  it("propagates a generate failure rather than inventing an answer", async () => {
    const generate = mock(() => Promise.reject(new Error("model unreachable")));
    await expect(
      synthesizeAnswer("q", { hits: [hit()], evidence: "weak" }, generate),
    ).rejects.toThrow("model unreachable");
  });
});
