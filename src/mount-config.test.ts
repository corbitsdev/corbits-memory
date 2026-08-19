import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadMemoryConfig } from "./mount-config.ts";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost:5432/test",
  EMBED_BASE_URL: "http://embed.example",
  EMBED_MODEL: "test-model",
};

const ENV_KEYS = [
  ...Object.keys(REQUIRED_ENV),
  "EMBED_TIMEOUT_MS",
  "RERANK_TIMEOUT_MS",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("loadMemoryConfig — EMBED_TIMEOUT_MS / RERANK_TIMEOUT_MS", () => {
  it("leaves embed.timeoutMs and rerank.timeoutMs undefined when unset, so the clients' own defaults apply", () => {
    const config = loadMemoryConfig();
    expect(config.memory.embed?.timeoutMs).toBeUndefined();
    expect(config.memory.rerank.timeoutMs).toBeUndefined();
  });

  it("flows EMBED_TIMEOUT_MS through to embed.timeoutMs", () => {
    process.env.EMBED_TIMEOUT_MS = "20000";
    const config = loadMemoryConfig();
    expect(config.memory.embed?.timeoutMs).toBe(20_000);
  });

  it("flows RERANK_TIMEOUT_MS through to rerank.timeoutMs", () => {
    process.env.RERANK_TIMEOUT_MS = "15000";
    const config = loadMemoryConfig();
    expect(config.memory.rerank.timeoutMs).toBe(15_000);
  });

  it("rejects a non-positive-integer EMBED_TIMEOUT_MS", () => {
    process.env.EMBED_TIMEOUT_MS = "not-a-number";
    expect(() => loadMemoryConfig()).toThrow(
      "EMBED_TIMEOUT_MS must be a positive integer",
    );
  });
});

describe("loadMemoryConfig — optional embed (CL-6287)", () => {
  it("constructs with DATABASE_URL alone: embed is absent, not required", () => {
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    const config = loadMemoryConfig();
    expect(config.memory.embed).toBeUndefined();
  });

  it("builds embed when both EMBED_BASE_URL and EMBED_MODEL are set", () => {
    const config = loadMemoryConfig();
    expect(config.memory.embed).toEqual({
      baseUrl: "http://embed.example",
      model: "test-model",
      apiStyle: "openai",
      apiKey: undefined,
      timeoutMs: undefined,
    });
  });

  it("rejects EMBED_BASE_URL set without EMBED_MODEL", () => {
    delete process.env.EMBED_MODEL;
    expect(() => loadMemoryConfig()).toThrow(
      "EMBED_BASE_URL and EMBED_MODEL must both be set or both be unset",
    );
  });

  it("rejects EMBED_MODEL set without EMBED_BASE_URL", () => {
    delete process.env.EMBED_BASE_URL;
    expect(() => loadMemoryConfig()).toThrow(
      "EMBED_BASE_URL and EMBED_MODEL must both be set or both be unset",
    );
  });

  it("treats a whitespace-only EMBED_BASE_URL as unset, not as a blank baseUrl", () => {
    process.env.EMBED_BASE_URL = "   ";
    expect(() => loadMemoryConfig()).toThrow(
      "EMBED_BASE_URL and EMBED_MODEL must both be set or both be unset",
    );
  });
});
