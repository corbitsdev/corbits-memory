/**
 * Memory / vector plane config — the core engine behind add/search/list.
 *
 * This is the low-level engine config consumed by the DB client and internal
 * services. The SDK's mount-level config (`MemoryConfig`, see
 * mount-config.ts) carries this as its `knowledge` sub-object. There is no
 * standalone server here — the SDK mounts onto a host Interchange app, so there
 * is no port, service token, or process entrypoint.
 */
export type EngineConfig = {
  databaseUrl: string;
  dbPoolMax: number;
  // Must match the language the knowledge_chunk.text_fts column was built
  // with (runMemoryMigrations verifies this against the catalog).
  // Required and concrete: loadMemoryConfig / createMemory resolve
  // the default (DEFAULT_FTS_LANGUAGE) once via parseFtsLanguage so services
  // never re-default. Constructing EngineConfig by hand — pass
  // DEFAULT_FTS_LANGUAGE (or parseFtsLanguage(undefined)) explicitly.
  ftsLanguage: string;
  // A model endpoint (embed or rerank) is just a URL + capability options,
  // trusted the same as KNOWLEDGE_DATABASE_URL — including a self-hosted endpoint on
  // localhost or a private IP. Self-hosted or managed makes no difference:
  // there is no self-host flag anywhere in the engine.
  embed: {
    baseUrl: string;
    model: string;
    apiStyle: string;
    apiKey: string | undefined;
    // Per-request timeout override (EMBED_TIMEOUT_MS). `undefined` means
    // "use embed-client.ts's own default" — must NOT be defaulted here.
    timeoutMs: number | undefined;
  };
  rerank: {
    baseUrl: string | undefined;
    model: string | undefined;
    apiKey: string | undefined;
    // Per-document character budget sent to the reranker — an explicit
    // operator override (RERANK_MAX_DOC_CHARS). `undefined` means "derive
    // from the resolved model's advertised token limit" — see
    // `defaultMaxDocCharsForModel` / `validateRerankConfig` in
    // rerank-client.ts. Must NOT be defaulted here: the default depends on
    // which model is resolved (this object doesn't know), and baking in a
    // single constant is exactly how a small-model budget got applied to
    // the default model's much larger context window.
    maxDocChars: number | undefined;
    // Per-request timeout override (RERANK_TIMEOUT_MS). `undefined` means
    // "use rerank-client.ts's own default" — must NOT be defaulted here.
    timeoutMs: number | undefined;
  };
};
