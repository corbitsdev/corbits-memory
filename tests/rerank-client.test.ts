import { afterAll, beforeEach, describe, expect, test } from "bun:test";

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
} from "../src/core/rerank-client.ts";
import { startHttpStub } from "./lib/http-stub.ts";

// .env.example ships RERANK_MODEL=bge-reranker-base with RERANK_MAX_DOC_CHARS
// unset; that combination must validate.
const DEFAULT_SHIPPED_MODEL = "bge-reranker-base";

const stub = startHttpStub();
afterAll(() => stub.stop());
beforeEach(() => stub.reset());

const tei = { baseUrl: stub.url, apiStyle: "tei" } as const;
const teiBaseModel = {
  baseUrl: stub.url,
  apiStyle: "tei",
  model: "bge-reranker-base",
} as const;
const teiBudget = (maxDocChars: number) =>
  ({ baseUrl: stub.url, apiStyle: "tei", maxDocChars }) as const;
const docs = [
  { id: "chunk-a", text: "alpha content" },
  { id: "chunk-b", text: "beta content" },
];

function teiTexts(): string[] {
  return stub.requests.map((r) => (r.body as { texts: string[] }).texts[0] ?? "");
}

describe("rerankDocuments", () => {
  test("sends nothing for no documents", async () => {
    expect(await rerankDocuments("q", [], tei)).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  test("speaks the tei, cohere and voyage wire shapes and maps scores to ids", async () => {
    stub.reply = (req) => {
      if (req.path === "/rerank") {
        return Response.json([
          { index: 1, score: 0.9 },
          { index: 0, score: 0.2 },
        ]);
      }
      if (req.path === "/v2/rerank") {
        return Response.json({ results: [{ index: 0, relevance_score: 0.75 }] });
      }
      return Response.json({
        data: [
          { index: 0, relevance_score: 0.4 },
          { index: 1, relevance_score: 0.6 },
        ],
      });
    };

    expect(await rerankDocuments("my query", docs, tei)).toEqual([
      { id: "chunk-b", score: 0.9 },
      { id: "chunk-a", score: 0.2 },
    ]);
    expect(
      await rerankDocuments("my query", docs, {
        baseUrl: stub.url,
        apiStyle: "cohere",
        apiKey: "secret-key",
      }),
    ).toEqual([{ id: "chunk-a", score: 0.75 }]);
    expect(
      await rerankDocuments("my query", docs, { baseUrl: stub.url, apiStyle: "voyage" }),
    ).toEqual([
      { id: "chunk-b", score: 0.6 },
      { id: "chunk-a", score: 0.4 },
    ]);

    const texts = ["alpha content", "beta content"];
    expect(stub.requests.map((r) => [r.path, r.authorization, r.body])).toEqual([
      ["/rerank", null, { query: "my query", texts }],
      [
        "/v2/rerank",
        "Bearer secret-key",
        { model: DEFAULT_RERANK_MODEL, query: "my query", documents: texts },
      ],
      ["/v1/rerank", null, { model: DEFAULT_RERANK_MODEL, query: "my query", documents: texts }],
    ]);
  });

  test("rejects a non-2xx reply with RerankHttpError", async () => {
    stub.reply = () => Response.json({ error: "boom" }, { status: 500 });
    await expect(rerankDocuments("q", docs, tei)).rejects.toBeInstanceOf(RerankHttpError);
  });

  test("rejects a reply slower than timeoutMs with RerankTimeoutError", async () => {
    stub.reply = async () => {
      await Bun.sleep(200);
      return Response.json([]);
    };
    await expect(
      rerankDocuments("q", docs, { baseUrl: stub.url, apiStyle: "tei", timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(RerankTimeoutError);
  });

  const baseBudget = defaultMaxDocCharsForModel("bge-reranker-base");
  test.each([
    ["the default model's own budget", "", DEFAULT_MAX_DOC_CHARS + 500, tei, DEFAULT_MAX_DOC_CHARS],
    ["an explicit bge-reranker-base budget", "", baseBudget + 500, teiBaseModel, baseBudget],
    ["a configured maxDocChars, less a one-character query", "q", 1_200, teiBudget(1_000), 999],
    ["an at-budget document, untouched", "", DEFAULT_MAX_DOC_CHARS, tei, DEFAULT_MAX_DOC_CHARS],
    ["a configured maxDocChars, less a long query", "q".repeat(150), 1_200, teiBudget(1_000), 850],
    ["exactly the minimum document budget", "q".repeat(800), 500, teiBudget(1_000), 200],
  ] as const)("truncates to %s", async (_label, query, docChars, config, expected) => {
    stub.reply = () => Response.json([{ index: 0, score: 0.5 }]);
    await rerankDocuments(query, [{ id: "c", text: "x".repeat(docChars) }], config);
    expect(teiTexts()[0]?.length).toBe(expected);
  });

  test("refuses without a request when the query leaves too little document budget", async () => {
    const one = [{ id: "c", text: "x".repeat(500) }];
    await expect(
      rerankDocuments("q".repeat(801), one, teiBudget(1_000)),
    ).rejects.toBeInstanceOf(RerankQueryTooLongError);
    await expect(
      rerankDocuments("q".repeat(10_000), one, teiBudget(300)),
    ).rejects.toBeInstanceOf(RerankQueryTooLongError);
    expect(stub.requests).toEqual([]);
  });

  test("trims before truncating so leading padding is not all that is sent", async () => {
    stub.reply = () => Response.json([{ index: 0, score: 0.5 }]);
    await rerankDocuments(
      "q",
      [{ id: "c", text: " ".repeat(220) + "real content that matters" }],
      teiBudget(220),
    );
    expect(teiTexts()[0]?.trim().length).toBeGreaterThan(0);
    expect(teiTexts()[0]).toContain("real content");
  });
});

describe("validateRerankConfig", () => {
  test("passes for the REAL shipped default (bge-reranker-base, its own default budget) — the exact combination .env.example ships unmodified", () => {
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

  // `model` is optional and most deployments never set it, which
  // resolves to DEFAULT_RERANK_MODEL (bge-reranker-v2-m3, 8,192 tokens) —
  // not bge-reranker-base. Validation must run against THAT resolution, not
  // early-return because `config.model` is undefined.
  test("validates the engine's true default (no model set at all) against DEFAULT_RERANK_MODEL, not bge-reranker-base", () => {
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

  test("passes for a smaller custom budget against a known model with a large enough limit", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "bge-reranker-base",
        maxDocChars: 1_200,
      }),
    ).not.toThrow();
  });

  test("throws RerankConfigError when maxDocChars can overflow a known model's token limit", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "bge-reranker-base",
        maxDocChars: 5_000,
      }),
    ).toThrow(RerankConfigError);
  });

  test("passes for bge-reranker-v2-m3 with its own much larger default budget", () => {
    expect(() =>
      validateRerankConfig({
        baseUrl: "https://tei.example.com",
        apiStyle: "tei",
        model: "bge-reranker-v2-m3",
      }),
    ).not.toThrow();
  });

  // An unrecognized model is validated against the conservative fallback
  // limit (512 tokens, the smallest known TEI cross-encoder limit).
  test("validates an unlisted model against the conservative fallback limit rather than skipping", () => {
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

  test("skips validation for non-TEI api styles", () => {
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
