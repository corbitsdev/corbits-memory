// Hard caps every chunking strategy respects. token.recursive (this
// package's only strategy today) is the fallback: an adapter may declare a
// preferred structure-aware strategy later, but every adapter falls back to
// this one until then.
export type ChunkCaps = {
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
};

// 512-800 max, ~40 min (merge-remnant), 50-80 overlap.
export const DEFAULT_CHUNK_CAPS: ChunkCaps = {
  maxTokens: 700,
  minTokens: 40,
  overlapTokens: 60,
};

export type ChunkSpan = {
  start: number;
  end: number;
};

export type TokenChunkMetadata = {
  strategy: "token.recursive";
};

export type TokenChunk = {
  ordinal: number;
  text: string;
  tokenCount: number;
  span: ChunkSpan;
  metadata: TokenChunkMetadata;
};

// The chunker port `adaptAndPlan` calls through — default is
// `chunkTokenRecursive`, but callers may inject a structure-aware strategy
// later without adaptAndPlan needing to change.
export type Chunker = (text: string, caps?: Partial<ChunkCaps>) => TokenChunk[];
