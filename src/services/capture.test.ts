import { describe, expect, it } from "bun:test";
import { toEmbedClientConfig } from "./capture.ts";
import type { EngineConfig } from "../config.ts";

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

  it("returns undefined when EngineConfig.embed is absent (no embedding account configured)", () => {
    expect(toEmbedClientConfig(undefined)).toBeUndefined();
  });
});
