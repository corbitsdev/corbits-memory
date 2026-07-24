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
  };
};
