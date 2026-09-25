import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  EmbedHttpError,
  EmbedTimeoutError,
  embedTexts,
  probeEmbedDims,
} from "../src/core/embed-client.ts";
import { startHttpStub } from "./lib/http-stub.ts";

const stub = startHttpStub();
afterAll(() => stub.stop());
beforeEach(() => stub.reset());

const openai = { baseUrl: stub.url, modelId: "text-embed-3", apiStyle: "openai" } as const;

describe("embedTexts", () => {
  test("sends nothing for empty input", async () => {
    expect(await embedTexts([], openai)).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  test("speaks the openai, tei and ollama wire shapes", async () => {
    stub.reply = (req) => {
      const body = req.body as { input?: string[]; inputs?: string[] };
      const texts = body.input ?? body.inputs ?? [];
      const vectors = texts.map((t) => [t.length, 0]);
      if (req.path === "/v1/embeddings") {
        return Response.json({ data: vectors.map((embedding) => ({ embedding })) });
      }
      if (req.path === "/embed") return Response.json(vectors);
      return Response.json({ embeddings: vectors });
    };

    expect(await embedTexts(["a", "bb"], openai)).toEqual([[1, 0], [2, 0]]);
    expect(
      await embedTexts(["a", "bb"], { baseUrl: stub.url, modelId: "bge-m3", apiStyle: "tei" }),
    ).toEqual([[1, 0], [2, 0]]);
    expect(
      await embedTexts(["a", "bb"], {
        baseUrl: stub.url,
        modelId: "nomic-embed-text",
        apiStyle: "ollama",
      }),
    ).toEqual([[1, 0], [2, 0]]);

    expect(stub.requests.map((r) => [r.path, r.body])).toEqual([
      ["/v1/embeddings", { model: "text-embed-3", input: ["a", "bb"] }],
      ["/embed", { inputs: ["a", "bb"] }],
      ["/api/embed", { model: "nomic-embed-text", input: ["a", "bb"], truncate: true }],
    ]);
  });

  test("sends the bearer token only when apiKey is set, and batches per batchSize", async () => {
    stub.reply = (req) =>
      Response.json({
        data: (req.body as { input: string[] }).input.map(() => ({ embedding: [1] })),
      });

    await embedTexts(["a", "b", "c"], {
      baseUrl: stub.url,
      modelId: "text-embed-3",
      apiStyle: "openai",
      apiKey: "secret",
      batchSize: 2,
    });
    await embedTexts(["d"], openai);

    expect(
      stub.requests.map((r) => [r.authorization, (r.body as { input: string[] }).input]),
    ).toEqual([
      ["Bearer secret", ["a", "b"]],
      ["Bearer secret", ["c"]],
      [null, ["d"]],
    ]);
  });

  test("rejects a non-2xx reply with EmbedHttpError carrying the status", async () => {
    stub.reply = () => new Response("server exploded", { status: 500 });
    const err = await embedTexts(["a"], openai).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedHttpError);
    expect((err as EmbedHttpError).status).toBe(500);
  });

  test("rejects a reply slower than timeoutMs with EmbedTimeoutError", async () => {
    stub.reply = async () => {
      await Bun.sleep(200);
      return Response.json({ data: [{ embedding: [1] }] });
    };
    await expect(
      embedTexts(["a"], {
        baseUrl: stub.url,
        modelId: "text-embed-3",
        apiStyle: "openai",
        timeoutMs: 20,
      }),
    ).rejects.toThrow(
      EmbedTimeoutError,
    );
  });
});

test("probeEmbedDims returns the served vector length", async () => {
  stub.reply = () => Response.json({ data: [{ embedding: new Array(768).fill(0) }] });
  expect(await probeEmbedDims(openai)).toBe(768);
});
