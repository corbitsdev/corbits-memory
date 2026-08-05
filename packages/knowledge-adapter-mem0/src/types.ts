/**
 * MemoryProvider port — defined locally so this adapter never imports
 * runtime from @corbits/knowledge-engine. Shape matches core ports/types.
 */
export type MemoryProvider = {
  remember(params: {
    tenantId: string;
    principalId: string;
    text: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  recall(params: {
    tenantId: string;
    principalId: string;
    query: string;
    limit?: number;
  }): Promise<Array<{ text: string; score?: number }>>;
};

export type Mem0MemoryProviderOptions = {
  /** Mem0 platform API key (sent as `Authorization: Token …`). */
  apiKey: string;
  /** API origin; default `https://api.mem0.ai`. */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch;
};
