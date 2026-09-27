import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";

import { RerankConfigError } from "../src/core/rerank-client.ts";
import {
  createMemory,
  MemoryError,
  type Memory,
  type MemoryAddParams,
} from "../src/memory.ts";
import {
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  testMemoryConfig,
  type TestDb,
} from "./helpers.ts";

async function rejection(run: Promise<unknown>): Promise<MemoryError> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MemoryError);
  return err as MemoryError;
}

describe.skipIf(testDatabaseUrl() === undefined)("in-process memory", () => {
  let db: TestDb;
  let memory: Memory | undefined;
  let withExtractor: Memory | undefined;

  beforeAll(async () => {
    db = await createTestDb();
    await seedPrincipal(db, "acme", "alice");
    memory = createTestMemory(db, createInMemoryGrantStore([]));
    withExtractor = createMemory({
      config: testMemoryConfig(db),
      textExtractor: {
        extract: async ({ filename }) => ({
          text: `extracted from ${filename}`,
          title: "From extractor",
        }),
      },
    });
  });

  afterAll(async () => {
    await memory?.close();
    await withExtractor?.close();
    await db?.close();
  });

  async function accessTags(documentId: string): Promise<string[]> {
    const [row] = await db.sql<{ access_tags: string[] }[]>`
      SELECT access_tags FROM memory.document WHERE id = ${documentId}`;
    return [...(row?.access_tags ?? [])].sort();
  }

  test.each([
    [
      "search below 1",
      (m: Memory) =>
        m.search({
          tenantId: "acme",
          principalId: "alice",
          query: "q",
          limit: 0,
        }),
    ],
    [
      "search above 50",
      (m: Memory) =>
        m.search({
          tenantId: "acme",
          principalId: "alice",
          query: "q",
          limit: 51,
        }),
    ],
    [
      "list below 1",
      (m: Memory) =>
        m.list({ tenantId: "acme", principalId: "alice", limit: 0 }),
    ],
    [
      "list above 100",
      (m: Memory) =>
        m.list({ tenantId: "acme", principalId: "alice", limit: 101 }),
    ],
  ] as const)("rejects a limit %s with a 400", async (_label, call) => {
    const err = await rejection(call(memory as Memory));
    expect(err.status).toBe(400);
  });

  test("add needs exactly one of content or file", async () => {
    const neither = await rejection(
      (memory as Memory).add({
        tenantId: "acme",
        principalId: "alice",
      } as MemoryAddParams),
    );
    const both = await rejection(
      (memory as Memory).add({
        tenantId: "acme",
        principalId: "alice",
        content: { title: "T", text: "body" },
        file: { bytes: new Uint8Array([1]) },
      }),
    );
    for (const err of [neither, both]) {
      expect(err.status).toBe(400);
      expect(err.message).toContain("content or file");
    }
  });

  test("add with a file needs a textExtractor and stores what it extracts", async () => {
    const file = { bytes: new Uint8Array([1, 2, 3]), filename: "note.pdf" };
    const missing = await rejection(
      (memory as Memory).add({ tenantId: "acme", principalId: "alice", file }),
    );
    expect(missing.status).toBe(400);
    expect(missing.message).toContain("textExtractor");

    const { documentId } = await (withExtractor as Memory).add({
      tenantId: "acme",
      principalId: "alice",
      file,
    });
    const [row] = await db.sql<{ title: string; text: string }[]>`
      SELECT d.title, c.text FROM memory.document d
        JOIN memory.chunk c ON c.document_id = d.id
        WHERE d.id = ${documentId}`;
    expect(row).toEqual({
      title: "From extractor",
      text: "extracted from note.pdf",
    });
  });

  test("share maps to access tags, peers also get the document tag, and the default is owner-only", async () => {
    const m = memory as Memory;
    const owner = await m.add({
      tenantId: "acme",
      principalId: "alice",
      content: { title: "Private", text: "private body" },
    });
    const tenant = await m.add({
      tenantId: "acme",
      principalId: "alice",
      content: { title: "Team", text: "team body" },
      share: { tenant: true },
    });
    const peers = await m.add({
      tenantId: "acme",
      principalId: "alice",
      content: { title: "Peers", text: "peers body" },
      share: { principals: ["bob", "carol"] },
    });

    expect(await accessTags(owner.documentId)).toEqual(["memory.owner:alice"]);
    expect(await accessTags(tenant.documentId)).toEqual([
      "memory.owner:alice",
      "memory.tenant:acme",
    ]);
    expect(await accessTags(peers.documentId)).toEqual([
      `memory.doc:${peers.documentId}`,
      "memory.owner:alice",
      "memory.owner:bob",
      "memory.owner:carol",
    ]);
  });

  test("search filters by kind and returns evidence only when asked", async () => {
    const m = memory as Memory;
    await m.add({
      tenantId: "acme",
      principalId: "alice",
      content: { title: "Kiwi decision", text: "We chose kiwi for the logo." },
      kind: "decision",
    });
    await m.add({
      tenantId: "acme",
      principalId: "alice",
      content: { title: "Kiwi note", text: "Kiwi is a fruit." },
    });

    const decisions = await m.search({
      tenantId: "acme",
      principalId: "alice",
      query: "kiwi",
      kinds: ["decision"],
    });
    expect(decisions.items.map((i) => i.title)).toEqual(["Kiwi decision"]);
    expect("evidence" in decisions).toBe(false);

    const withEvidence = await m.search({
      tenantId: "acme",
      principalId: "alice",
      query: "kiwi",
      includeEvidence: true,
    });
    expect(withEvidence.items.length).toBe(2);
    expect(withEvidence.evidence).toBeDefined();
  });

  test("reports whether dense retrieval is configured", async () => {
    expect((memory as Memory).capabilities.embeddingsConfigured).toBe(false);
    const lexical = testMemoryConfig(db);
    const dense = createMemory({
      config: {
        memory: {
          databaseUrl: lexical.memory.databaseUrl,
          dbPoolMax: lexical.memory.dbPoolMax,
          ftsLanguage: lexical.memory.ftsLanguage,
          embed: {
            baseUrl: "http://embed.test",
            model: "nomic-embed-text",
            apiStyle: "ollama",
            apiKey: undefined,
            timeoutMs: undefined,
          },
          rerank: lexical.memory.rerank,
        },
      },
    });
    expect(dense.capabilities.embeddingsConfigured).toBe(true);
    await dense.close();
    const custom = createMemory({
      documentStore: {
        add: async () => ({ documentId: "d1", versionId: "v1" }),
        search: async () => ({ items: [] }),
        list: async () => [],
        close: async () => {},
      },
    });
    expect(custom.capabilities.embeddingsConfigured).toBe(true);
    await custom.close();
  });

  test("re-adding identical content returns the existing document", async () => {
    const m = memory as Memory;
    const params = {
      tenantId: "acme",
      principalId: "alice",
      content: { title: "Same", text: "identical body" },
      externalRef: "same-ref",
    };
    const first = await m.add(params);
    const second = await m.add(params);
    expect(second.documentId).toBe(first.documentId);
  });

  test("construction fails on a rerank budget that overflows the model", () => {
    const config = testMemoryConfig(db);
    expect(() =>
      createMemory({
        config: {
          memory: {
            databaseUrl: config.memory.databaseUrl,
            dbPoolMax: config.memory.dbPoolMax,
            ftsLanguage: config.memory.ftsLanguage,
            rerank: {
              baseUrl: "http://tei.test",
              model: "bge-reranker-base",
              apiKey: undefined,
              maxDocChars: 5_000,
              timeoutMs: undefined,
            },
          },
        },
      }),
    ).toThrow(RerankConfigError);
  });
});
