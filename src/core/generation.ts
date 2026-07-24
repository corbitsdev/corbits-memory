// The replay-generation tag every knowledge_version row carries. The normal /capture
// path always writes this generation; a replay (transform-run) writes its
// own generation (the run id) instead, so a replayed corpus never touches or
// is visible alongside the live one unless a caller explicitly asks for it.
export const LIVE_GENERATION = "live";
