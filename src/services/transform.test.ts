import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { buildRerankClientConfig } from "./transform.ts";
import { TransformConfigParamsSchema } from "../core/schemas/transform.ts";

describe("buildRerankClientConfig", () => {
  it("returns undefined when no baseUrl is configured (falls through to engine defaults)", () => {
    expect(buildRerankClientConfig(undefined)).toBeUndefined();
    expect(buildRerankClientConfig({})).toBeUndefined();
  });

  it("defaults apiStyle to 'tei' when omitted, mirroring the engine's own rerank config precedent", () => {
    const config = buildRerankClientConfig({ baseUrl: "https://rerank.example" });
    expect(config).toEqual({
      baseUrl: "https://rerank.example",
      apiStyle: "tei",
    });
  });

  it("carries the configured apiStyle and model through untouched", () => {
    const config = buildRerankClientConfig({
      baseUrl: "https://rerank.example",
      apiStyle: "cohere",
      model: "rerank-v3",
    });
    expect(config).toEqual({
      baseUrl: "https://rerank.example",
      apiStyle: "cohere",
      model: "rerank-v3",
    });
  });
});

describe("TransformConfigParamsSchema", () => {
  it("accepts a fully-specified params object", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive", maxTokens: 500 },
      embed: { baseUrl: "http://localhost:11434", model: "nomic-embed-text", apiStyle: "ollama" },
      rerank: { baseUrl: "https://rerank.example", apiStyle: "tei" },
      authorityWeight: 0.8,
      recencyHalfLifeDays: 45,
      mmrLambda: 0.6,
      overfetch: 4,
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects an unknown chunk strategy — token.recursive is the only one adaptAndPlan supports", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "semantic.experimental" },
      embed: { baseUrl: "http://localhost:11434", model: "nomic-embed-text", apiStyle: "ollama" },
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  it("accepts a partial embed override — every omitted field inherits the engine's embed config", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive" },
      embed: { model: "a-different-model" },
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("accepts params with no embed override at all — the replay reuses the engine's embed endpoint", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive" },
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects an unknown embed apiStyle", () => {
    const parsed = TransformConfigParamsSchema({
      chunk: { strategy: "token.recursive" },
      embed: { apiStyle: "not-a-real-style" },
    });
    expect(parsed instanceof type.errors).toBe(true);
  });
});
