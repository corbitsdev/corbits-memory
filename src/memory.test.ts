/**
 * Plane construction, grant-tag ACL wiring, and surface coverage for memory.ts.
 *
 * - Construction: rerank maxDocChars validation runs in createMemory.
 * - Search wiring: grant-tag post-filter (creator-only without grants).
 * - add(): documentId return, content/file XOR, share → access tags.
 * - search/list: limit bounds, evidence default omit.
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
  createMemory,
  MemoryError,
  type MemoryAddParams,
  type SearchItem,
  type TextExtractor,
} from "./memory.ts";
import type { MemoryConfig } from "./mount-config.ts";
import * as realDb from "./db/client.ts";
import * as realSearch from "./services/search.ts";
import * as realCapture from "./services/capture.ts";
import * as realRetention from "./services/retention.ts";
import type { HybridSearchResult } from "./services/search.ts";

const PRINCIPAL = "p1";
const TENANT = "t1";

type DocAclRow = {
  id: string;
  access_tags: string[] | null;
  created_by: string | null;
};

/** Satisfies createFtsVerification → createRawSqlClient(sql).unsafe on the find path. */
const ENGLISH_FTS_EXPR = "to_tsvector('english'::regconfig, text)";

function grant(action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "memory",
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

const wiringConfig: MemoryConfig = {
  memory: {
    databaseUrl: "postgres://localhost:5432/nonexistent-test-db",
    dbPoolMax: 1,
    ftsLanguage: "english",
    embed: {
      baseUrl: "http://embed",
      model: "m",
      apiStyle: "openai",
      apiKey: undefined,
      timeoutMs: undefined,
    },
    rerank: {
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      maxDocChars: undefined,
      timeoutMs: undefined,
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
  rerank: MemoryConfig["memory"]["rerank"],
): MemoryConfig {
  return {
    memory: {
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
        timeoutMs: undefined,
      },
      rerank,
    },
  };
}

describe("createMemory — construction validation", () => {
  it("throws RerankConfigError when maxDocChars overflows a known TEI model", () => {
    // Proves validateRerankConfig runs inside createMemory (not only
    // createMemory): a standalone plane with a bad override must fail
    // construction, not silently degrade on every later find.
    expect(() =>
      createMemory({
        config: baseConfig({
          baseUrl: "https://tei.example.com",
          model: "bge-reranker-base",
          apiKey: undefined,
          maxDocChars: 5_000,
          timeoutMs: undefined,
        }),
      }),
    ).toThrow(RerankConfigError);
  });
});

// CL-6287 review: a consumer (settings page, health check) must be able to
// learn recall is lexical-only WITHOUT issuing a search first.
describe("createMemory — capabilities.embeddingsConfigured (CL-6287)", () => {
  it("reports true when EngineConfig.embed is configured", async () => {
    const plane = createMemory({
      config: baseConfig({
        baseUrl: undefined,
        model: undefined,
        apiKey: undefined,
        maxDocChars: undefined,
        timeoutMs: undefined,
      }),
    });
    expect(plane.capabilities.embeddingsConfigured).toBe(true);
    await plane.close();
  });

  it("reports false when EngineConfig.embed is absent (lexical-only)", async () => {
    const config: MemoryConfig = {
      memory: {
        databaseUrl: "postgres://localhost:5432/nonexistent-test-db",
        dbPoolMax: 1,
        ftsLanguage: "english",
        rerank: {
          baseUrl: undefined,
          model: undefined,
          apiKey: undefined,
          maxDocChars: undefined,
          timeoutMs: undefined,
        },
      },
    };
    const plane = createMemory({ config });
    expect(plane.capabilities.embeddingsConfigured).toBe(false);
    await plane.close();
  });

  it("defaults to true for a custom DocumentStore that doesn't report its own capabilities", async () => {
    const plane = createMemory({
      documentStore: {
        add: async () => ({ documentId: "d1", versionId: "v1" }),
        search: async () => ({ items: [] }),
        list: async () => [],
        close: async () => {},
      },
    });
    expect(plane.capabilities.embeddingsConfigured).toBe(true);
    await plane.close();
  });
});

describe("createMemory.find — grant-tag post-filter wiring", () => {
  const hybridSearch = mock((): Promise<HybridSearchResult> =>
    Promise.resolve({
      hits: [hit("d-other"), hit("d-mine")],
      evidence: "strong",
    }),
  );

  const sql = Object.assign(
    mock((): Promise<DocAclRow[]> =>
      Promise.resolve([
        {
          id: "d-other",
          access_tags: ["memory.owner:other"],
          created_by: "other",
        },
        {
          id: "d-mine",
          access_tags: [`memory.owner:${PRINCIPAL}`],
          created_by: PRINCIPAL,
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

  it("keeps creator docs and drops others when grants are absent", async () => {
    // Without grants the engine store is creator-only (safe default).
    hybridSearch.mockClear();
    hybridSearch.mockImplementation(() =>
      Promise.resolve({
        hits: [hit("d-other"), hit("d-mine")],
        evidence: "strong" as const,
      }),
    );
    sql.mockClear();
    sql.mockImplementation(() =>
      Promise.resolve([
        {
          id: "d-other",
          access_tags: ["memory.owner:other"],
          created_by: "other",
        },
        {
          id: "d-mine",
          access_tags: [`memory.owner:${PRINCIPAL}`],
          created_by: PRINCIPAL,
        },
      ]),
    );

    const { createMemory: makePlane } = await import(
      `./memory.ts?wiring-blocked=${Date.now()}`
    );
    const plane = makePlane({ config: wiringConfig });

    const result = await plane.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
      includeEvidence: true,
    });

    expect(hybridSearch).toHaveBeenCalled();
    expect(result.items.map((i: SearchItem) => i.documentId)).toEqual([
      "d-mine",
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

    const { createMemory: makePlane } = await import(
      `./memory.ts?wiring-kinds=${Date.now()}`
    );
    const plane = makePlane({ config: wiringConfig });

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

  it("withholds a hit whose row did not come back (fail-closed)", async () => {
    hybridSearch.mockClear();
    hybridSearch.mockImplementation(() =>
      Promise.resolve({
        hits: [hit("d-missing")],
        evidence: "strong" as const,
      }),
    );
    sql.mockClear();
    sql.mockImplementation(() => Promise.resolve([]));

    const { createMemory: makePlane } = await import(
      `./memory.ts?wiring-unreadable=${Date.now()}`
    );
    const plane = makePlane({ config: wiringConfig });

    const result = await plane.search({
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
      Promise.resolve([
        {
          id: "d-open",
          access_tags: [`memory.owner:${PRINCIPAL}`],
          created_by: PRINCIPAL,
        },
      ]),
    );

    const { createMemory: makePlane } = await import(
      `./memory.ts?wiring-evidence=${Date.now()}`
    );
    const plane = makePlane({ config: wiringConfig });


    const without = await plane.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "q",
    });
    expect(without.items).toHaveLength(1);
    expect(without.evidence).toBeUndefined();
    expect(without.degraded).toBeUndefined();

    const withEv = await plane.search({
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

describe("search/list — limit bounds", () => {
  // These throw before any DB work, so a nonexistent URL is fine.
  it("find rejects limit below 1", async () => {
    const plane = createMemory({ config: wiringConfig });
    try {
      await plane.search({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        query: "q",
        limit: 0,
      });
      throw new Error("expected find() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).status).toBe(400);
      expect((err as MemoryError).message).toContain("limit");
    }
  });

  it("find rejects limit above 50", async () => {
    const plane = createMemory({ config: wiringConfig });
    try {
      await plane.search({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        query: "q",
        limit: 51,
      });
      throw new Error("expected find() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).status).toBe(400);
    }
  });

  it("recent rejects limit above 100", async () => {
    const plane = createMemory({ config: wiringConfig });
    try {
      await plane.list({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        limit: 101,
      });
      throw new Error("expected recent() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).status).toBe(400);
    }
  });

  it("recent rejects limit below 1", async () => {
    const plane = createMemory({ config: wiringConfig });
    try {
      await plane.list({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        limit: 0,
      });
      throw new Error("expected recent() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).status).toBe(400);
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
    const { createMemory: makePlane } = await import(
      `./memory.ts?add-${Date.now()}-${Math.random()}`
    );
    return makePlane({ config: wiringConfig, ...(opts ?? {}) });

  }

  /** Dynamic re-import yields a distinct MemoryError class; match by shape. */
  function expectMemoryError400(err: unknown, messagePart: string) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("MemoryError");
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
    expect(result).toEqual({ documentId: "kdoc_captured", versionId: "kver_1" });
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
    expect(result).toEqual({ documentId: "kdoc_noop", versionId: "kver_1" });
    await plane.close();
  });

  it("rejects when neither content nor file is provided", async () => {
    const plane = await freshPlane();
    try {
      await plane.add({
        tenantId: TENANT,
        principalId: PRINCIPAL,
      } as MemoryAddParams);
      throw new Error("expected add() to reject");
    } catch (err) {
      expectMemoryError400(err, "content or file");
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
      expectMemoryError400(err, "content or file");
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
      expectMemoryError400(err, "textExtractor");
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

  it("maps share.tenant to tenant access tag", async () => {
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
      content: { title: "Team note", text: "shared" },
      share: { tenant: true },
    });
    const call = captureDocument.mock.calls[0] as unknown as [
      unknown,
      {
        document: {
          accessTags: string[];
        };
      },
    ];
    expect(call[1].document.accessTags).toContain(
      `memory.owner:${PRINCIPAL}`,
    );
    expect(call[1].document.accessTags).toContain(
      `memory.tenant:${TENANT}`,
    );
    await plane.close();
  });

  it("maps share.principals to peer owner tags", async () => {
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
      share: { principals: ["alice", "bob"] },
    });
    const call = captureDocument.mock.calls[0] as unknown as [
      unknown,
      {
        document: {
          accessTags: string[];
        };
      },
    ];
    expect(call[1].document.accessTags).toContain(
      `memory.owner:${PRINCIPAL}`,
    );
    expect(call[1].document.accessTags).toContain("memory.owner:alice");
    expect(call[1].document.accessTags).toContain("memory.owner:bob");
    await plane.close();
  });

  it("defaults to owner-only access tags", async () => {
    captureDocument.mockClear();
    captureDocument.mockImplementation(() =>
      Promise.resolve({
        status: "captured" as const,
        documentId: "kdoc_default",
        versionId: "kver_1",
        chunks: 1,
      }),
    );
    const plane = await freshPlane();
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "T", text: "body" },
    });
    const call = captureDocument.mock.calls[0] as unknown as [
      unknown,
      {
        document: {
          accessTags: string[];
        };
      },
    ];
    expect(call[1].document.accessTags).toEqual([
      `memory.owner:${PRINCIPAL}`,
    ]);
    await plane.close();
  });
});

describe("retention writes — ownership gate (CL-6288)", () => {
  const OWNER = "alice";
  const OTHER = "mallory";

  const tombstoneDocument = mock(() => Promise.resolve({ versions: 1 }));
  const hardDeleteDocument = mock(() => Promise.resolve({ deleted: true }));
  const setRetentionClass = mock(() =>
    Promise.resolve({
      versionId: "ver-1",
      documentId: "doc-1",
      status: "active",
    }),
  );

  /**
   * Only "doc-1" / "ver-1" exist, created by OWNER — everything else is a
   * miss. resolveDocumentOwner and resolveVersionOwner both just need "a
   * creator row" here (their distinct WHERE clauses are unit-tested with
   * real scoping in retention-ownership.test.ts) so this fake does not
   * branch on query text — a branch whose arms return the same row proves
   * nothing and only invites the reader to assume a distinction that isn't
   * there.
   */
  const sql = Object.assign(
    mock((_strings: TemplateStringsArray, ...values: unknown[]) => {
      const isMissing =
        values.includes("doc-missing") || values.includes("ver-missing");
      if (isMissing) return Promise.resolve([]);
      return Promise.resolve([{ created_by_principal_id: OWNER }]);
    }),
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
    mock.module("./services/retention.ts", () => ({
      ...realRetention,
      tombstoneDocument,
      hardDeleteDocument,
      setRetentionClass,
    }));
  });

  afterAll(() => {
    mock.module("./db/client.ts", () => realDb);
    mock.module("./services/retention.ts", () => realRetention);
  });

  async function freshPlane() {
    const { createMemory: makePlane } = await import(
      `./memory.ts?retention-${Date.now()}-${Math.random()}`
    );
    return makePlane({ config: wiringConfig });
  }

  function expectMemoryError(err: unknown, status: number, messagePart: string) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("MemoryError");
    expect((err as { status: number }).status).toBe(status);
    expect((err as Error).message).toContain(messagePart);
  }

  it("tombstoneDocument succeeds for the creator", async () => {
    tombstoneDocument.mockClear();
    const plane = await freshPlane();
    const result = await plane.tombstoneDocument({
      tenantId: TENANT,
      principalId: OWNER,
      documentId: "doc-1",
    });
    expect(result).toEqual({ versions: 1 });
    expect(tombstoneDocument).toHaveBeenCalled();
    await plane.close();
  });

  it("tombstoneDocument is refused for a non-creator even with document visibility", async () => {
    tombstoneDocument.mockClear();
    const plane = await freshPlane();
    try {
      await plane.tombstoneDocument({
        tenantId: TENANT,
        principalId: OTHER,
        documentId: "doc-1",
      });
      throw new Error("expected tombstoneDocument to reject");
    } catch (err) {
      expectMemoryError(err, 403, "creator");
    }
    expect(tombstoneDocument).not.toHaveBeenCalled();
    await plane.close();
  });

  it("tombstoneDocument 404s for an unknown document", async () => {
    tombstoneDocument.mockClear();
    const plane = await freshPlane();
    try {
      await plane.tombstoneDocument({
        tenantId: TENANT,
        principalId: OWNER,
        documentId: "doc-missing",
      });
      throw new Error("expected tombstoneDocument to reject");
    } catch (err) {
      expectMemoryError(err, 404, "not found");
    }
    expect(tombstoneDocument).not.toHaveBeenCalled();
    await plane.close();
  });

  it("hardDeleteDocument succeeds for the creator", async () => {
    hardDeleteDocument.mockClear();
    const plane = await freshPlane();
    const result = await plane.hardDeleteDocument({
      tenantId: TENANT,
      principalId: OWNER,
      documentId: "doc-1",
    });
    expect(result).toEqual({ deleted: true });
    expect(hardDeleteDocument).toHaveBeenCalled();
    await plane.close();
  });

  it("hardDeleteDocument is refused for a non-creator even with document visibility", async () => {
    hardDeleteDocument.mockClear();
    const plane = await freshPlane();
    try {
      await plane.hardDeleteDocument({
        tenantId: TENANT,
        principalId: OTHER,
        documentId: "doc-1",
      });
      throw new Error("expected hardDeleteDocument to reject");
    } catch (err) {
      expectMemoryError(err, 403, "creator");
    }
    expect(hardDeleteDocument).not.toHaveBeenCalled();
    await plane.close();
  });

  it("setRetentionClass succeeds for the version's creator", async () => {
    setRetentionClass.mockClear();
    const plane = await freshPlane();
    const result = await plane.setRetentionClass({
      tenantId: TENANT,
      principalId: OWNER,
      versionId: "ver-1",
      retentionClass: "durable",
    });
    expect(result).toEqual({
      versionId: "ver-1",
      documentId: "doc-1",
      status: "active",
    });
    expect(setRetentionClass).toHaveBeenCalled();
    await plane.close();
  });

  it("setRetentionClass is refused for a non-creator", async () => {
    setRetentionClass.mockClear();
    const plane = await freshPlane();
    try {
      await plane.setRetentionClass({
        tenantId: TENANT,
        principalId: OTHER,
        versionId: "ver-1",
        retentionClass: "durable",
      });
      throw new Error("expected setRetentionClass to reject");
    } catch (err) {
      expectMemoryError(err, 403, "creator");
    }
    expect(setRetentionClass).not.toHaveBeenCalled();
    await plane.close();
  });

  it("setRetentionClass 404s for an unknown version", async () => {
    setRetentionClass.mockClear();
    const plane = await freshPlane();
    try {
      await plane.setRetentionClass({
        tenantId: TENANT,
        principalId: OWNER,
        versionId: "ver-missing",
        retentionClass: "durable",
      });
      throw new Error("expected setRetentionClass to reject");
    } catch (err) {
      expectMemoryError(err, 404, "not found");
    }
    expect(setRetentionClass).not.toHaveBeenCalled();
    await plane.close();
  });
});
