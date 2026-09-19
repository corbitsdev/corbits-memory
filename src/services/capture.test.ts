import { describe, expect, it, mock } from "bun:test";
import { embedInsertedChunksWithConfig, toEmbedClientConfig } from "./capture.ts";
import type { CaptureInput } from "./capture.ts";
import type { Db, RawSql } from "../db/client.ts";
import type { EngineConfig } from "../config.ts";
import type { EmbedClientConfig } from "../core/embed-client.ts";
import type { EmbeddableChunk } from "../core/embed-worker.ts";

// Regression for the capture path silently timing out at embed-client.ts's
// default (10000ms) even when EMBED_TIMEOUT_MS was set: capture.ts used to
// build its own EmbedClientConfig literal instead of going through the same
// mapping search.ts used, and dropped timeoutMs. capture.ts now re-exports
// the one shared mapping (engine-client-config.ts) — assert it carries
// EngineConfig.embed.timeoutMs through on the capture path specifically.
describe("capture path embed client config", () => {
  it("carries EngineConfig.embed.timeoutMs through to the capture-path EmbedClientConfig", () => {
    const embed: EngineConfig["embed"] = {
      baseUrl: "http://embed.example",
      model: "test-model",
      apiStyle: "openai",
      apiKey: undefined,
      timeoutMs: 5000,
    };

    const embedClientConfig = toEmbedClientConfig(embed);

    expect(embedClientConfig?.timeoutMs).toBe(5000);
  });

  it("leaves timeoutMs undefined (so embed-client.ts's own default applies) when EngineConfig doesn't set one", () => {
    const embed: EngineConfig["embed"] = {
      baseUrl: "http://embed.example",
      model: "test-model",
      apiStyle: "openai",
      apiKey: undefined,
      timeoutMs: undefined,
    };

    const embedClientConfig = toEmbedClientConfig(embed);

    expect(embedClientConfig?.timeoutMs).toBeUndefined();
  });

  it("returns undefined when EngineConfig.embed is absent (no embed endpoint configured)", () => {
    expect(toEmbedClientConfig(undefined)).toBeUndefined();
  });
});

// CL-6287 review: `add`'s `degraded` must be a reason array (like search's
// `DegradeFlag[]`), never a bare boolean, so a host can write one
// "is this response degraded" check across both verbs.
describe("embedInsertedChunksWithConfig — degraded reason array (CL-6287)", () => {
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

  const oneChunk: EmbeddableChunk[] = [{ id: "chunk_1", text: "hello world" }];

  it("returns an empty array (not a boolean) when there are no chunks to embed", async () => {
    const result = await embedInsertedChunksWithConfig(
      untouchableRawSql(),
      "tenant-1",
      [],
      undefined,
    );
    expect(result.degraded).toEqual([]);
  });

  it("reports [embed_unavailable, lexical_only] when no embed endpoint is configured, without touching the embed-model registry", async () => {
    const result = await embedInsertedChunksWithConfig(
      untouchableRawSql(),
      "tenant-1",
      oneChunk,
      undefined,
    );
    expect(result.degraded).toEqual(["embed_unavailable", "lexical_only"]);
  });
});

// CL-8615: a busy local Ollama (embeddings queued behind chat inference)
// must never stall the `add` tool call — capture commits the rows, returns
// `{status: "captured"}` with no network await, and embeds detached with
// retry plus a bounded pending-chunk sweep.
const BACKGROUND_TEST_DIMS = 128;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// OpenAI-compatible success body sized to the request batch, so the same
// stub can serve the dims probe (1 text) and chunk embeds (N texts).
function openaiEmbeddingBody(initBody: unknown): unknown {
  let count = 1;
  try {
    const parsed = JSON.parse(String(initBody ?? "{}")) as { input?: unknown };
    if (Array.isArray(parsed.input)) count = parsed.input.length;
  } catch {
    count = 1;
  }
  return {
    data: Array.from({ length: count }, () => ({
      embedding: new Array(BACKGROUND_TEST_DIMS).fill(0.1),
    })),
  };
}

function unreachableRawSql(): RawSql {
  return {
    unsafe: () => {
      throw new Error("rawSql.unsafe must not be called on the synchronous capture path");
    },
  } as unknown as RawSql;
}

// memory.test.ts uses `mock.module("./services/capture.ts", ...)` around its
// own describe blocks; Bun's module registry is process-global, so a static
// `import { captureDocument } from "./capture.ts"` here can end up bound to
// that mock's fixture data when the whole suite runs (the same leak
// services/search.test.ts documents for hybridSearch). A cache-busted
// dynamic import — the same trick memory.test.ts itself uses for
// `./memory.ts` — sidesteps this: a fresh module specifier is never the one
// any mock.module call replaced.
async function loadRealCapture(): Promise<typeof import("./capture.ts")> {
  return import(`./capture.ts?cl-8615-real=${Date.now()}-${Math.random()}`);
}

describe("captureDocument defers embedding to the background (CL-8615)", () => {
  it("returns captured with zero fetch calls when the embedder hangs, scheduling the embed pass instead", async () => {
    const { captureDocument } = await loadRealCapture();
    const hangingFetch = mock(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;
    const scheduled: Array<() => Promise<void>> = [];
    // The tx result is canned so this test isolates the post-commit
    // scheduling decision (row-store writes are covered elsewhere), not the
    // drizzle transaction body.
    const db = {
      transaction: () =>
        Promise.resolve({
          status: "captured",
          documentId: "doc_1",
          versionId: "ver_1",
          insertedChunks: [{ id: "chunk_1", text: "hello world" }],
        }),
    } as unknown as Db;
    const config = {
      embed: {
        baseUrl: "http://embed.example",
        model: "test-model",
        apiStyle: "openai",
        apiKey: undefined,
        timeoutMs: undefined,
      },
    } as unknown as EngineConfig;
    const input: CaptureInput = {
      tenantId: "tenant-1",
      adapter: "test-adapter",
      occurredAt: new Date().toISOString(),
      document: {
        kind: "note",
        title: "hello",
        externalRef: "ext-1",
        accessTags: [],
        entityHints: [],
        chunks: [{ ordinal: 0, text: "hello world" }],
        contentHash: "hash-1",
      },
    };

    // The timeout race proves the point directly: if captureDocument awaited
    // the hanging embedder, this rejects instead of resolving.
    const result = await Promise.race([
      captureDocument({ db, sql: unreachableRawSql(), config }, input, {
        fetchImpl: hangingFetch,
        schedule: (task) => {
          scheduled.push(task);
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("captureDocument awaited the embedder")), 1000),
      ),
    ]);

    expect(result).toEqual({
      status: "captured",
      documentId: "doc_1",
      versionId: "ver_1",
      chunks: 1,
    });
    expect(hangingFetch).toHaveBeenCalledTimes(0);
    expect(scheduled).toHaveLength(1);
  });
});

describe("runBackgroundEmbedPass retries then sweeps pending (CL-8615)", () => {
  it("retries after a refused embed call with the 1s delay, then embeds fresh chunks and sweeps one pending chunk", async () => {
    const { runBackgroundEmbedPass } = await loadRealCapture();
    let fetchCalls = 0;
    const flakyFetch = (async (_url: unknown, init?: { body?: unknown }) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434 (busy local ollama)");
      }
      return jsonResponse(openaiEmbeddingBody(init?.body));
    }) as unknown as typeof fetch;
    const sleepDelays: number[] = [];
    const sqlCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    let pendingSelectCalls = 0;
    const sql = {
      unsafe: (text: string, params: readonly unknown[]) => {
        sqlCalls.push({ sql: text, params });
        if (text.includes("LEFT JOIN")) {
          pendingSelectCalls++;
          if (pendingSelectCalls === 1) {
            return Promise.resolve([{ id: "chunk_pending", text: "pending text" }]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    } as unknown as RawSql;
    const embedClientConfig: EmbedClientConfig = {
      baseUrl: "http://embed.example",
      modelId: "test-model",
      apiStyle: "openai",
    };

    // Never throws — a detached task must not produce an unhandled rejection.
    await runBackgroundEmbedPass(
      sql,
      "tenant-1",
      [{ id: "chunk_fresh", text: "fresh text" }],
      embedClientConfig,
      {
        fetchImpl: flakyFetch,
        sleep: (ms: number) => {
          sleepDelays.push(ms);
          return Promise.resolve();
        },
      },
    );

    // Exactly one retry: attempt 1's probe is refused (1 fetch), attempt 2
    // probes (1) + embeds fresh (1), then the sweep probes (1) + embeds the
    // pending chunk (1).
    expect(fetchCalls).toBe(5);
    expect(sleepDelays).toEqual([1000]);
    const embeddedIds = sqlCalls
      .filter((call) => call.sql.startsWith('INSERT INTO "memory"."embedding_'))
      .map((call) => call.params[0]);
    expect(embeddedIds).toContain("chunk_fresh");
    expect(embeddedIds).toContain("chunk_pending");
  });
});

describe("background embed pass honors the configured embed timeout (CL-8615)", () => {
  it("threads EngineConfig.embed.timeoutMs through to every fetch init signal", async () => {
    const { runBackgroundEmbedPass } = await loadRealCapture();
    const timeoutMs = 45000;
    const seenSignals: unknown[] = [];
    const timeoutArgs: number[] = [];
    const observingFetch = (async (_url: unknown, init?: { body?: unknown; signal?: unknown }) => {
      seenSignals.push(init?.signal);
      return jsonResponse(openaiEmbeddingBody(init?.body));
    }) as unknown as typeof fetch;
    const sql = {
      unsafe: () => Promise.resolve([]),
    } as unknown as RawSql;
    const embedClientConfig: EmbedClientConfig = {
      baseUrl: "http://embed.example",
      modelId: "test-model",
      apiStyle: "openai",
      timeoutMs,
    };

    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      timeoutArgs.push(ms);
      return originalTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
      await runBackgroundEmbedPass(
        sql,
        "tenant-1",
        [{ id: "chunk_1", text: "hello world" }],
        embedClientConfig,
        { fetchImpl: observingFetch, maxAttempts: 1 },
      );
    } finally {
      AbortSignal.timeout = originalTimeout;
    }

    // Probe + chunk embed, each carrying its own timeout signal.
    expect(seenSignals.length).toBeGreaterThan(0);
    for (const signal of seenSignals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(timeoutArgs.length).toBeGreaterThan(0);
    for (const ms of timeoutArgs) {
      expect(ms).toBe(timeoutMs);
    }
  });
});
