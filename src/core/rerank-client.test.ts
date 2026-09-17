import { describe, expect, it, mock } from "bun:test";

import {
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_RERANK_MODEL,
  KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS,
  RerankConfigError,
  RerankHttpError,
  RerankQueryTooLongError,
  RerankTimeoutError,
  defaultMaxDocCharsForModel,
  rerankDocuments,
  validateRerankConfig,
} from "./rerank-client.ts";
import type { RerankClientConfig } from "./rerank-client.ts";

// The default env in .env.example ships RERANK_MODEL=bge-reranker-base with
// RERANK_MAX_DOC_CHARS unset (-> defaultMaxDocCharsForModel's per-model
// value). That exact combination must not throw — an earlier version of
// this budget failed its own validation on the shipped defaults, which
// would have taken down every host that never touched the rerank env vars.
const DEFAULT_SHIPPED_MODEL = "bge-reranker-base";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const teiConfig: RerankClientConfig = {
  baseUrl: "https://tei.example.com",
  apiStyle: "tei",
};

const cohereConfig: RerankClientConfig = {
  baseUrl: "https://api.cohere.example.com",
  apiStyle: "cohere",
  apiKey: "secret-key",
};

const voyageConfig: RerankClientConfig = {
  baseUrl: "https://api.voyage.example.com",
  apiStyle: "voyage",
};

const docs = [
  { id: "chunk-a", text: "alpha content" },
  { id: "chunk-b", text: "beta content" },
];

describe("rerankDocuments", () => {
  it("returns [] on empty docs without calling fetch", async () => {
    const fetchImpl = mock(() => Promise.resolve(jsonResponse([])));
    const result = await rerankDocuments(
      "query",
      [],
      teiConfig,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("issues the TEI shape and maps index -> requested doc id, sorted desc", async () => {
    const fetchImpl = mock((url: string, init: RequestInit) => {
      expect(url).toBe("https://tei.example.com/rerank");
      const body = JSON.parse(init.body as string) as {
        query: string;
        texts: string[];
      };
      expect(body.query).toBe("my query");
      expect(body.texts).toEqual(["alpha content", "beta content"]);
      return Promise.resolve(
        jsonResponse([
          { index: 1, score: 0.9 },
          { index: 0, score: 0.2 },
        ]),
      );
    });

    const result = await rerankDocuments(
      "my query",
      docs,
      teiConfig,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual([
      { id: "chunk-b", score: 0.9 },
      { id: "chunk-a", score: 0.2 },
    ]);
  });

  it("issues the Cohere v2 shape with the bearer auth header and default model", async () => {
    const fetchImpl = mock((url: string, init: RequestInit) => {
      expect(url).toBe("https://api.cohere.example.com/v2/rerank");
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer secret-key",
      );
      const body = JSON.parse(init.body as string) as {
        model: string;
        query: string;
        documents: string[];
      };
      expect(body.model).toBe("bge-reranker-v2-m3");
      expect(body.documents).toEqual(["alpha content", "beta content"]);
      return Promise.resolve(
        jsonResponse({
          results: [{ index: 0, relevance_score: 0.75 }],
        }),
      );
    });

    const result = await rerankDocuments(
      "my query",
      docs,
      cohereConfig,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual([{ id: "chunk-a", score: 0.75 }]);
  });

  it("issues the Voyage shape", async () => {
    const fetchImpl = mock((url: string, init: RequestInit) => {
      expect(url).toBe("https://api.voyage.example.com/v1/rerank");
      const body = JSON.parse(init.body as string) as {
        model: string;
        query: string;
        documents: string[];
      };
      expect(body.model).toBe("bge-reranker-v2-m3");
      return Promise.resolve(
        jsonResponse({
          data: [
            { index: 0, relevance_score: 0.4 },
            { index: 1, relevance_score: 0.6 },
          ],
        }),
      );
    });

    const result = await rerankDocuments(
      "my query",
      docs,
      voyageConfig,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual([
      { id: "chunk-b", score: 0.6 },
      { id: "chunk-a", score: 0.4 },
    ]);
  });

  it("throws RerankHttpError on a non-ok response", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(jsonResponse({ error: "boom" }, 500)),
    );
    await expect(
      rerankDocuments(
        "q",
        docs,
        teiConfig,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(RerankHttpError);
  });

  it("throws RerankTimeoutError when the request aborts", async () => {
    const fetchImpl = mock(() => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      return Promise.reject(err);
    });
    await expect(
      rerankDocuments(
        "q",
        docs,
        teiConfig,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(RerankTimeoutError);
  });

  const baseBudget = defaultMaxDocCharsForModel("bge-reranker-base");
  it.each([
    // The default-model row is the Finding A case: with no `model` set the
    // unconfigured default must use DEFAULT_RERANK_MODEL's own budget — NOT
    // the smaller bge-reranker-base-calibrated value.
    ["default model's own budget", "", DEFAULT_MAX_DOC_CHARS + 500, {}, DEFAULT_MAX_DOC_CHARS],
    ["explicit bge-reranker-base budget", "", baseBudget + 500, { model: "bge-reranker-base" }, baseBudget],
    ["configured maxDocChars", "q", 1_200, { maxDocChars: 1_000 }, 999],
    ["at-budget text passes through untruncated", "", DEFAULT_MAX_DOC_CHARS, {}, DEFAULT_MAX_DOC_CHARS],
  ])("resolves the document budget — %s", async (_label, query, docChars, override, expected) => {
    const fetchImpl = mock((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { texts: string[] };
      expect(body.texts[0]?.length).toBe(expected);
      return Promise.resolve(jsonResponse([{ index: 0, score: 0.5 }]));
    });

    await rerankDocuments(
      query,
      [{ id: "chunk-c", text: "x".repeat(docChars) }],
      { ...teiConfig, ...override },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["reserves the query's length out of the pair cap", "q".repeat(150), 1_200, 1_000, 850],
    // Query 800 chars against a 1000 budget leaves exactly MIN_DOC_CHARS
    // (200): must still run, not skip.
    ["exact MIN_DOC_CHARS boundary still runs", "q".repeat(800), 500, 1_000, 200],
    // One char longer leaves 199, one under MIN_DOC_CHARS: must throw and
    // never touch the network rather than forcing the budget back up.
    ["one char under MIN_DOC_CHARS skips without fetch", "q".repeat(801), 500, 1_000, "throws"],
    ["query dwarfing maxDocChars skips outright", "q".repeat(10_000), 500, 300, "throws"],
  ])("query-length reserve — %s", async (_label, query, docChars, maxDocChars, expected) => {
    const expectedChars: number | null =
      expected === "throws" ? null : (expected as number);
    const fetchImpl = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { texts: string[] };
      if (expectedChars !== null) {
        expect(body.texts[0]?.length).toBe(expectedChars);
      }
      return Promise.resolve(jsonResponse([{ index: 0, score: 0.5 }]));
    });

    const run = rerankDocuments(
      query,
      [{ id: "chunk-c", text: "x".repeat(docChars) }],
      { ...teiConfig, maxDocChars },
      fetchImpl as unknown as typeof fetch,
    );
    if (expected === "throws") {
      await expect(run).rejects.toBeInstanceOf(RerankQueryTooLongError);
      expect(fetchImpl).not.toHaveBeenCalled();
    } else {
      await run;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("trims before truncating so leading padding doesn't yield an all-whitespace document", async () => {
    const paddedDoc = {
      id: "chunk-c",
      text: " ".repeat(220) + "real content that matters",
    };
    const fetchImpl = mock((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { texts: string[] };
      expect(body.texts[0]?.trim().length).toBeGreaterThan(0);
      expect(body.texts[0]).toContain("real content");
      return Promise.resolve(jsonResponse([{ index: 0, score: 0.5 }]));
    });

    await rerankDocuments(
      "q",
      [paddedDoc],
      { ...teiConfig, maxDocChars: 220 },
      fetchImpl as unknown as typeof fetch,
    );
  });

  it("does not truncate documents at or under the budget", async () => {
    const shortDoc = { id: "chunk-c", text: "x".repeat(DEFAULT_MAX_DOC_CHARS) };
    const fetchImpl = mock((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { texts: string[] };
      expect(body.texts[0]?.length).toBe(DEFAULT_MAX_DOC_CHARS);
      return Promise.resolve(jsonResponse([{ index: 0, score: 0.5 }]));
    });

    await rerankDocuments(
      "", // empty query: isolate document-only truncation from the query reserve
      [shortDoc],
      teiConfig,
      fetchImpl as unknown as typeof fetch,
    );
  });
});

describe("validateRerankConfig", () => {
  it("passes for the REAL shipped default (bge-reranker-base, its own default budget) — the exact combination .env.example ships unmodified", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: DEFAULT_SHIPPED_MODEL,
        maxDocChars: defaultMaxDocCharsForModel(DEFAULT_SHIPPED_MODEL),
      }),
    ).not.toThrow();
    // Also exercise the config-omitted path, since that's what
    // toRerankClientConfig actually produces when RERANK_MAX_DOC_CHARS is unset.
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: DEFAULT_SHIPPED_MODEL,
      }),
    ).not.toThrow();
  });

  // Finding A: `model` is optional and most deployments never set it, which
  // resolves to DEFAULT_RERANK_MODEL (bge-reranker-v2-m3, 8,192 tokens) —
  // not bge-reranker-base. Validation must run against THAT resolution, not
  // early-return because `config.model` is undefined.
  it("validates the engine's true default (no model set at all) against DEFAULT_RERANK_MODEL, not bge-reranker-base", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
      }),
    ).not.toThrow();

    // A maxDocChars sized for bge-reranker-base's smaller limit is nowhere
    // near enough to trip DEFAULT_RERANK_MODEL's much larger one.
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        maxDocChars: defaultMaxDocCharsForModel("bge-reranker-base"),
      }),
    ).not.toThrow();

    // But a maxDocChars that overflows DEFAULT_RERANK_MODEL's real 8,192-token
    // limit must still be caught, not skipped because model was omitted.
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        maxDocChars: (KNOWN_TEI_RERANK_MODEL_TOKEN_LIMITS[DEFAULT_RERANK_MODEL] ?? 0) * 100,
      }),
    ).toThrow(RerankConfigError);
  });

  it("passes for a smaller custom budget against a known model with a large enough limit", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "bge-reranker-base",
        maxDocChars: 1_200,
      }),
    ).not.toThrow();
  });

  it("throws RerankConfigError when maxDocChars can overflow a known model's token limit", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "bge-reranker-base",
        maxDocChars: 5_000,
      }),
    ).toThrow(RerankConfigError);
  });

  it("passes for bge-reranker-v2-m3 with its own much larger default budget", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "bge-reranker-v2-m3",
      }),
    ).not.toThrow();
  });

  // An unrecognized model no longer skips validation outright — it resolves
  // to the conservative fallback limit (512 tokens, the smallest known TEI
  // cross-encoder limit) instead.
  it("validates an unlisted model against the conservative fallback limit rather than skipping", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "some-custom-reranker",
        maxDocChars: 100_000,
      }),
    ).toThrow(RerankConfigError);

    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "some-custom-reranker",
        // Within the conservative (512-token) fallback's own default budget.
      }),
    ).not.toThrow();
  });

  it("skips validation for non-TEI api styles", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://api.cohere.example.com",
        apiStyle: "cohere",
        model: "bge-reranker-base",
        maxDocChars: 100_000,
      }),
    ).not.toThrow();
  });
});
