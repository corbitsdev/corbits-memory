import type { EngineConfig } from "./config.ts";
import { parseFtsLanguage } from "./core/fts-language.ts";

/**
 * SDK config — what `createMemory` consumes.
 *
 * The host Interchange app owns auth, tenancy, grants, and the process. This
 * config carries only what the memory engine itself needs: its vector DB +
 * model endpoints.
 */
export type MemoryConfig = {
  /** Memory / vector plane (the engine's own DB + model endpoints). */
  memory: EngineConfig;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`${name} is required`);
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

// No fallback: `undefined` means "let rerank-client derive the budget from
// the resolved model" rather than baking in a value calibrated for a
// different model. See `EngineConfig.rerank.maxDocChars`.
function optionalIntEnv(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/**
 * Build a config from environment variables — a convenience for env-driven
 * deploys. Hosts may also construct `MemoryConfig` programmatically (pass
 * `memory.databaseUrl` directly — no env required).
 *
 * Database URL resolution for env-driven loads: DATABASE_URL — same Postgres
 * as the host is fine; tables live under the `memory` schema, not public.
 */
export function loadMemoryConfig(): MemoryConfig {
  return {
    memory: {
      databaseUrl: requireEnv("DATABASE_URL"),
      dbPoolMax: intEnv("DB_POOL_MAX", 8),
      ftsLanguage: parseFtsLanguage(optionalEnv("FTS_LANGUAGE")),
      embed: {
        baseUrl: requireEnv("EMBED_BASE_URL"),
        model: requireEnv("EMBED_MODEL"),
        apiStyle: optionalEnv("EMBED_API_STYLE") ?? "openai",
        apiKey: optionalEnv("EMBED_API_KEY"),
        timeoutMs: optionalIntEnv("EMBED_TIMEOUT_MS"),
      },
      rerank: {
        baseUrl: optionalEnv("RERANK_BASE_URL"),
        model: optionalEnv("RERANK_MODEL"),
        apiKey: optionalEnv("RERANK_API_KEY"),
        maxDocChars: optionalIntEnv("RERANK_MAX_DOC_CHARS"),
        timeoutMs: optionalIntEnv("RERANK_TIMEOUT_MS"),
      },
    },
  };
}
