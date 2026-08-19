import { describe, expect, it } from "bun:test";
import { embedInsertedChunksWithConfig, toEmbedClientConfig } from "./capture.ts";
import type { EngineConfig } from "../config.ts";
import type { RawSql } from "../db/client.ts";
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
