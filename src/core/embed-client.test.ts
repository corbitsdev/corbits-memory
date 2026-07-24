import { describe, expect, it, mock } from "bun:test";

import {
  EmbedHttpError,
  EmbedTimeoutError,
  embedTexts,
  probeEmbedDims,
} from "./embed-client.ts";
import type { EmbedClientConfig } from "./embed-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const openAiConfig: EmbedClientConfig = {
  baseUrl: "https://api.example.com",
  modelId: "text-embed-3",
  apiStyle: "openai",
};

const teiConfig: EmbedClientConfig = {
  baseUrl: "https://tei.example.com",
  modelId: "bge-m3",
  apiStyle: "tei",
};

const ollamaConfig: EmbedClientConfig = {
  baseUrl: "http://localhost:11434",
  modelId: "nomic-embed-text",
  apiStyle: "ollama",
};

describe("embedTexts", () => {
  it("returns [] on empty input without calling fetch (T4)", async () => {
    const fetchImpl = mock(() => Promise.resolve(jsonResponse({})));
    const result = await embedTexts([], openAiConfig, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("embeds via the openai-compat shape, preserving order (T1)", async () => {
    const fetchImpl = mock((url: string, init: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/embeddings");
      const body = JSON.parse(init.body as string) as { model: string; input: string[] };
      expect(body.model).toBe("text-embed-3");
      return Promise.resolve(
        jsonResponse({
          data: body.input.map((_, i) => ({ embedding: [i, i + 1, i + 2] })),
        }),
      );
    });
    const result = await embedTexts(
      ["a", "b"],
      openAiConfig,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual([
      [0, 1, 2],
      [1, 2, 3],
    ]);
  });

  it("embeds via the TEI shape", async () => {
    const fetchImpl = mock((url: string, init: RequestInit) => {
      expect(url).toBe("https://tei.example.com/embed");
      const body = JSON.parse(init.body as string) as { inputs: string[] };
      expect(body.inputs).toEqual(["a", "b"]);
      return Promise.resolve(jsonResponse([[1, 2], [3, 4]]));
    });
    const result = await embedTexts(
      ["a", "b"],
      teiConfig,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("embeds via the Ollama /api/embed batch shape with truncate", async () => {
    const calls: unknown[] = [];
    const fetchImpl = mock((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        model: string;
        input: string[];
        truncate: boolean;
      };
      calls.push({ url, body });
      expect(url).toBe("http://localhost:11434/api/embed");
      expect(body.model).toBe("nomic-embed-text");
      expect(body.truncate).toBe(true);
      return Promise.resolve(
        jsonResponse({ embeddings: body.input.map((t) => [t.length, 0, 0]) }),
      );
    });
    const result = await embedTexts(
      ["hi", "hello"],
      ollamaConfig,
      fetchImpl as unknown as typeof fetch,
    );
    expect((calls[0] as { body: { input: string[] } }).body.input).toEqual([
      "hi",
      "hello",
    ]);
    expect(result).toEqual([
      [2, 0, 0],
      [5, 0, 0],
    ]);
  });

  it("sends a bearer token only when apiKey is set", async () => {
    let seenAuth: string | undefined;
    const fetchImpl = mock((_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>).authorization;
      return Promise.resolve(jsonResponse({ data: [{ embedding: [1] }] }));
    });
    await embedTexts(
      ["a"],
      { ...openAiConfig, apiKey: "secret-key" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(seenAuth).toBe("Bearer secret-key");

    const fetchImplNoKey = mock((_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return Promise.resolve(jsonResponse({ data: [{ embedding: [1] }] }));
    });
    await embedTexts(["a"], openAiConfig, fetchImplNoKey as unknown as typeof fetch);
  });

  it("batches sequentially per config.batchSize", async () => {
    const seenBatches: string[][] = [];
    const fetchImpl = mock((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      seenBatches.push(body.input);
      return Promise.resolve(
        jsonResponse({ data: body.input.map(() => ({ embedding: [1] })) }),
      );
    });
    await embedTexts(
      ["a", "b", "c"],
      { ...openAiConfig, batchSize: 2 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(seenBatches).toEqual([["a", "b"], ["c"]]);
  });

  it("rejects with EmbedHttpError on a non-2xx response, capturing status (T2)", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("server exploded", { status: 500 })),
    );
    await expect(
      embedTexts(["a"], openAiConfig, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(EmbedHttpError);
    try {
      await embedTexts(["a"], openAiConfig, fetchImpl as unknown as typeof fetch);
      throw new Error("expected embedTexts to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedHttpError);
      expect((err as EmbedHttpError).status).toBe(500);
    }
  });

  it("rejects with EmbedTimeoutError before the test itself times out (T3)", async () => {
    const neverResponds = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        });
      });
    await expect(
      embedTexts(
        ["a"],
        { ...openAiConfig, timeoutMs: 15 },
        neverResponds as unknown as typeof fetch,
      ),
    ).rejects.toThrow(EmbedTimeoutError);
  });
});

describe("probeEmbedDims", () => {
  it("returns the discovered vector length (T9)", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(jsonResponse({ data: [{ embedding: new Array(768).fill(0) }] })),
    );
    const dims = await probeEmbedDims(openAiConfig, fetchImpl as unknown as typeof fetch);
    expect(dims).toBe(768);
  });
});
