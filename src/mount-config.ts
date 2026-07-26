import type { EngineConfig } from "./config.ts";
import { TEI_MAX_DOC_CHARS } from "./core/rerank-client.ts";

/**
 * SDK mount config — what `mountKnowledgeEngine` consumes.
 *
 * The host Interchange app owns auth, tenancy, grants, and the process. This
 * config carries only what the knowledge engine itself needs: its vector DB +
 * model endpoints.
 */
export type KnowledgeConfig = {
  /** Knowledge / vector plane (the engine's own DB + model endpoints). */
  knowledge: EngineConfig;
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

/**
 * Build a config from environment variables — a convenience for env-driven
 * deploys. Hosts may also construct `KnowledgeConfig` programmatically.
 */
export function loadKnowledgeConfig(): KnowledgeConfig {
  return {
    knowledge: {
      // Deliberately no DATABASE_URL fallback: the host app's own database
      // must never be mistaken for the engine's vector plane.
      databaseUrl: requireEnv("KNOWLEDGE_DATABASE_URL"),
      dbPoolMax: intEnv("DB_POOL_MAX", 8),
      embed: {
        baseUrl: requireEnv("EMBED_BASE_URL"),
        model: requireEnv("EMBED_MODEL"),
        apiStyle: optionalEnv("EMBED_API_STYLE") ?? "openai",
        apiKey: optionalEnv("EMBED_API_KEY"),
      },
      rerank: {
        baseUrl: optionalEnv("RERANK_BASE_URL"),
        model: optionalEnv("RERANK_MODEL"),
        apiKey: optionalEnv("RERANK_API_KEY"),
        maxDocChars: intEnv("RERANK_MAX_DOC_CHARS", TEI_MAX_DOC_CHARS),
      },
    },
  };
}
