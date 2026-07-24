import { describe, expect, it, mock } from "bun:test";

import {
  RerankHttpError,
  RerankTimeoutError,
  rerankDocuments,
} from "./rerank-client.ts";
import type { RerankClientConfig } from "./rerank-client.ts";

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
});
