/**
 * Knowledge / vector plane config — the core capture + search engine.
 *
 * This is the low-level engine config consumed by the DB client and the
 * capture/search/transform services. The SDK's mount-level config
 * (`KnowledgeConfig`, see mount-config.ts) carries this as its `knowledge`
 * sub-object. There is no standalone server here — the SDK mounts onto a host
 * Interchange app, so there is no port, service token, or process entrypoint.
 */
export type EngineConfig = {
  databaseUrl: string;
  dbPoolMax: number;
  // Must match the language the knowledge_chunk.text_fts column was built
  // with (runKnowledgeMigrations verifies this against the catalog).
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
  };
};
