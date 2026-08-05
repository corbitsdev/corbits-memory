export type {
  DocumentStore,
  DocumentStoreAddParams,
  DocumentStoreFindItem,
  DocumentStoreFindParams,
  DocumentStoreFindResult,
  DocumentStoreRecentEvent,
  DocumentStoreRecentParams,
  Mem0ClientOptions,
  Mem0MemoryProviderOptions,
  MemoryProvider,
} from "./types.ts";
export { mapUser } from "./map-user.ts";
export { createMem0DocumentStore } from "./create-mem0-document-store.ts";
/** @deprecated Prefer createMem0DocumentStore as options.documentStore. */
export { createMem0MemoryProvider } from "./create-mem0-memory-provider.ts";
