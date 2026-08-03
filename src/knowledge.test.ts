/**
 * Plane construction, ACL wiring, and ask() coverage for knowledge.ts.
 *
 * - Construction: rerank maxDocChars validation runs in createKnowledgePlane.
 * - Find wiring: acl.test.ts covers blockedDocumentIds itself; the post-filter
 *   call site is pinned here so deleting or inverting it fails the suite.
 * - ask(): grant check, missing generate (501 before find), allow path,
 *   synthesizeAnswer grounding.
 * - add(): documentId return, content/file XOR, share → ACL mapping.
 * - find/recent: limit bounds, evidence default omit.
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
  type FindItem,
  type KnowledgeAddParams,
  type TextExtractor,
} from "./knowledge.ts";
import type { KnowledgeConfig } from "./mount-config.ts";
import * as realDb from "./db/client.ts";
import * as realSearch from "./services/search.ts";
import * as realCapture from "./services/capture.ts";
import type { HybridSearchResult } from "./services/search.ts";

const PRINCIPAL = "p1";
const TENANT = "t1";

type DocAclRow = {
  id: string;
  attributes: { acl_block?: unknown };
};

/** Satisfies createFtsVerification → createRawSqlClient(sql).unsafe on the find path. */
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

function findItemFromHit(h: SearchHit): FindItem {
  return {
    documentId: h.document_id,
    title: h.title,
    snippet: h.snippet,
    score: h.score,
    kind: h.kind,
    citation: h.citation,
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
    // construction, not silently degrade on every later find.
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

describe("createKnowledgePlane.find — ACL post-filter wiring", () => {
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
    const result = await plane.find({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
      includeEvidence: true,
    });

    expect(hybridSearch).toHaveBeenCalled();
    expect(result.items.map((i: FindItem) => i.documentId)).toEqual([
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
    await plane.find({
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
    const result = await plane.find({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
      includeEvidence: true,
    });

    expect(result.items).toEqual([]);
    expect(result.evidence).toBe("none");

    await plane.close();
  });

  it("omits evidence by default and includes it when includeEvidence is true", async () => {
    hybridSearch.mockClear();
    hybridSearch.mockImplementation(() =>
      Promise.resolve({
        hits: [hit("d-open")],
        evidence: "strong" as const,
        degraded: ["dense_unavailable" as const],
      }),
    );
    sql.mockClear();
    sql.mockImplementation(() =>
      Promise.resolve([{ id: "d-open", attributes: {} }]),
    );

    const { createKnowledgePlane: makePlane } = await import(
      `./knowledge.ts?wiring-evidence=${Date.now()}`
    );
    const plane = makePlane(wiringConfig);

    const without = await plane.find({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
    });
    expect(without.items).toHaveLength(1);
    expect(without.evidence).toBeUndefined();
    expect(without.degraded).toBeUndefined();

    const withEv = await plane.find({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
      includeEvidence: true,
    });
    expect(withEv.items).toHaveLength(1);
    expect(withEv.evidence).toBe("strong");
    expect(withEv.degraded).toEqual(["dense_unavailable"]);

    await plane.close();
  });
});

describe("find/recent — limit bounds", () => {
  // These throw before any DB work, so a nonexistent URL is fine.
  it("find rejects limit below 1", async () => {
    const plane = createKnowledgePlane(wiringConfig);
    try {
      await plane.find({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        query: "q",
        limit: 0,
      });
      throw new Error("expected find() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).status).toBe(400);
      expect((err as KnowledgeError).message).toContain("limit");
    }
  });

  it("find rejects limit above 50", async () => {
    const plane = createKnowledgePlane(wiringConfig);
    try {
      await plane.find({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        query: "q",
        limit: 51,
      });
      throw new Error("expected find() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).status).toBe(400);
    }
  });

  it("recent rejects limit above 100", async () => {
    const plane = createKnowledgePlane(wiringConfig);
    try {
      await plane.recent({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        limit: 101,
      });
      throw new Error("expected recent() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).status).toBe(400);
    }
  });

  it("recent rejects limit below 1", async () => {
    const plane = createKnowledgePlane(wiringConfig);
    try {
      await plane.recent({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        limit: 0,
      });
      throw new Error("expected recent() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).status).toBe(400);
    }
  });
});

describe("add() — documentId, content/file XOR, share", () => {
  type CaptureDocResult = {
    status: "captured" | "noop";
    documentId: string;
    versionId: string;
    chunks: number;
  };
  const captureDocument = mock(
    (): Promise<CaptureDocResult> =>
      Promise.resolve({
        status: "captured",
        documentId: "kdoc_test_1",
        versionId: "kver_1",
        chunks: 1,
      }),
  );

  const sql = Object.assign(mock(() => Promise.resolve([])), {
    end: mock(() => Promise.resolve()),
    unsafe: mock((sqlText: string) => ftsUnsafe(sqlText)),
  });

  beforeAll(() => {
    mock.module("./db/client.ts", () => ({
      ...realDb,
      createDb: () => ({ db: {}, sql }),
    }));
    mock.module("./services/capture.ts", () => ({
      ...realCapture,
      captureDocument,
    }));
  });

  afterAll(() => {
    mock.module("./db/client.ts", () => realDb);
    mock.module("./services/capture.ts", () => realCapture);
  });

async function freshPlane(opts?: {
    textExtractor?: TextExtractor;
  }) {
    const { createKnowledgePlane: makePlane } = await import(
      `./knowledge.ts?add-${Date.now()}-${Math.random()}`
    );
    return makePlane(wiringConfig, undefined, opts ?? {});
  }

  /** Dynamic re-import yields a distinct KnowledgeError class; match by shape. */
  function expectKnowledgeError400(err: unknown, messagePart: string) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("KnowledgeError");
    expect((err as { status: number }).status).toBe(400);
    expect((err as Error).message).toContain(messagePart);
  }

  it("returns documentId from captureDocument (captured status)", async () => {
    captureDocument.mockClear();
    captureDocument.mockImplementation(() =>
      Promise.resolve({
        status: "captured" as const,
        documentId: "kdoc_captured",
        versionId: "kver_1",
        chunks: 1,
      }),
    );
    const plane = await freshPlane();
    const result = await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "T", text: "body" },
    });
    expect(result).toEqual({ documentId: "kdoc_captured" });
    await plane.close();
  });

  it("returns documentId on noop status too", async () => {
    captureDocument.mockClear();
    captureDocument.mockImplementation(() =>
      Promise.resolve({
        status: "noop" as const,
        documentId: "kdoc_noop",
        versionId: "kver_1",
        chunks: 0,
      }),
    );
    const plane = await freshPlane();
    const result = await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "T", text: "body" },
    });
    expect(result).toEqual({ documentId: "kdoc_noop" });
    await plane.close();
  });

  it("rejects when neither content nor file is provided", async () => {
    const plane = await freshPlane();
    try {
      await plane.add({
        tenantId: TENANT,
        principalId: PRINCIPAL,
      } as KnowledgeAddParams);
      throw new Error("expected add() to reject");
    } catch (err) {
      expectKnowledgeError400(err, "content or file");
    }
    await plane.close();
  });

  it("rejects when both content and file are provided", async () => {
    const plane = await freshPlane();
    try {
      await plane.add({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        content: { title: "T", text: "body" },
        file: { bytes: new Uint8Array([1]) },
      });
      throw new Error("expected add() to reject");
    } catch (err) {
      expectKnowledgeError400(err, "content or file");
    }
    await plane.close();
  });

  it("rejects file without a textExtractor", async () => {
    const plane = await freshPlane();
    try {
      await plane.add({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        file: { bytes: new Uint8Array([1]), filename: "a.pdf" },
      });
      throw new Error("expected add() to reject");
    } catch (err) {
      expectKnowledgeError400(err, "textExtractor");
    }
    await plane.close();
  });

  it("extracts text via textExtractor when file is provided", async () => {
    captureDocument.mockClear();
    captureDocument.mockImplementation(() =>
      Promise.resolve({
        status: "captured" as const,
        documentId: "kdoc_file",
        versionId: "kver_1",
        chunks: 1,
      }),
    );
    const textExtractor: TextExtractor = {
      extract: mock(() =>
        Promise.resolve({ text: "extracted body", title: "From Extractor" }),
      ),
    };
    const plane = await freshPlane({ textExtractor });
    const result = await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      file: {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        filename: "note.pdf",
      },
    });
    expect(result.documentId).toBe("kdoc_file");
    expect(textExtractor.extract).toHaveBeenCalled();
    expect(captureDocument).toHaveBeenCalled();
    const call = captureDocument.mock.calls[0] as unknown as [
      unknown,
      { document: { title: string; chunks: { text: string }[] } },
    ];
    expect(call[1].document.title).toBe("From Extractor");
    expect(call[1].document.chunks[0]?.text).toBe("extracted body");
    await plane.close();
  });

  it("maps share private to visibility private with owner principalId", async () => {
    captureDocument.mockClear();
    captureDocument.mockImplementation(() =>
      Promise.resolve({
        status: "captured" as const,
        documentId: "kdoc_share",
        versionId: "kver_1",
        chunks: 1,
      }),
    );
    const plane = await freshPlane();
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "Private note", text: "secret" },
      share: { mode: "private", block: ["blocked-p"] },
    });
    const call = captureDocument.mock.calls[0] as unknown as [
      unknown,
      {
        document: {
          visibility: { mode: string; principalIds?: string[] };
          attributes?: { acl_block?: string };
        };
      },
    ];
    expect(call[1].document.visibility).toEqual({
      mode: "private",
      principalIds: [PRINCIPAL],
    });
    expect(call[1].document.attributes?.acl_block).toBe(
      JSON.stringify(["blocked-p"]),
    );
    await plane.close();
  });

  it("maps share principals and always includes the owner", async () => {
    captureDocument.mockClear();
    captureDocument.mockImplementation(() =>
      Promise.resolve({
        status: "captured" as const,
        documentId: "kdoc_principals",
        versionId: "kver_1",
        chunks: 1,
      }),
    );
    const plane = await freshPlane();
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "Shared", text: "body" },
      share: { mode: "principals", principalIds: ["alice", "bob"] },
    });
    const call = captureDocument.mock.calls[0] as unknown as [
      unknown,
      {
        document: {
          visibility: { mode: string; principalIds?: string[] };
        };
      },
    ];
    expect(call[1].document.visibility.mode).toBe("principals");
    const ids = call[1].document.visibility.principalIds ?? [];
    expect(ids).toContain(PRINCIPAL);
    expect(ids).toContain("alice");
    expect(ids).toContain("bob");
    await plane.close();
  });

  it("rejects share together with visibility", async () => {
    const plane = await freshPlane();
    try {
      await plane.add({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        content: { title: "T", text: "body" },
        share: { mode: "tenant" },
        visibility: { mode: "private", principalIds: [PRINCIPAL] },
      });
      throw new Error("expected add() to reject");
    } catch (err) {
      expectKnowledgeError400(err, "share or visibility");
    }
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
const denyGrant: GrantRule = { ...grant("find"), effect: "deny" };
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
  it("throws KnowledgeError 501 before find when generate is not wired", async () => {
    // Pointed at a nonexistent DB: if find ran first this would surface a
    // connection/driver error instead of the promised 501.
    const grants = {
grantStore: createInMemoryGrantStore([grant("find")]),
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
  it("finds as the principal and synthesizes when grant allows and generate is wired", async () => {
    const grants = {
      grantStore: createInMemoryGrantStore([grant("find")]),
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
    // Stub find so this unit test never needs a live Postgres. ask() looks
    // up plane.find at call time, so reassignment is the wiring under test.
    plane.find = mock(() =>
      Promise.resolve({
        items: [findItemFromHit(hit())],
        evidence: "strong" as const,
      }),
    );

    const result = await plane.ask({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "what is the answer?",
    });

    expect(plane.find).toHaveBeenCalledWith({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "what is the answer?",
      includeEvidence: true,
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
