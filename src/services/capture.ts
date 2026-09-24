import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db, RawSql } from "../db/client.js";
import type { EngineConfig } from "../config.js";
import { newId } from "../core/id.js";
import { formatCaughtError, log } from "../log.js";
import { stableStringify } from "../core/hash.js";
import { LIVE_GENERATION } from "../core/generation.js";
import {
  memoryChunk,
  memoryDocument,
  memoryEdge,
  memoryEntity,
  memoryVersion,
  rawCapture,
} from "../db/schema.js";
import {
  adaptAndPlan,
  type AdaptAndPlanOptions,
  type CapturePlan,
} from "../core/adapt-and-plan.js";
import { computeAuthority, type AuthoritySignals } from "../core/authority.js";
import type {
  AdaptedDocument,
  EntityHint,
} from "../core/schemas/adapted-document.js";
import type { MemoryEdgeHint } from "../core/schemas/entity-edge.js";
import { createRawSqlClient } from "../core/embed-sql.js";
import {
  activateEmbedModel,
  EMBED_TABLE_NAME_PATTERN,
  ensureEmbedModel,
  type ActiveEmbedTable,
  type EmbedRegistrySqlClient,
} from "../core/embed-model-registry.js";
import type { EmbedClientConfig } from "../core/embed-client.js";
import {
  embedChunks,
  type CaptureDegradedReason,
  type EmbeddableChunk,
} from "../core/embed-worker.js";
import { toEmbedClientConfig } from "../core/engine-client-config.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The single doorway a caller uses to reach the memory store: parses an
// already-adapted document into a capture plan (adaptAndPlan), writes
// document/version/chunk/edge rows in one transaction, then schedules
// background embedding of the version's chunks after commit (CL-8615 — a
// slow embedder never stalls the awaiting HTTP caller). Unlike a fire-and-forget capture hook, this
// IS the primary write the HTTP caller is waiting on — a real DB failure is
// allowed to throw (fail loud) rather than being swallowed into a
// `{status: "failed"}` result.
export type CaptureInput = {
  tenantId: string;
  adapter: string;
  occurredAt: string;
  document: AdaptedDocument;
};

// Re-exported so callers (memory.ts, ports/types.ts) get the one shared
// vocabulary — see the doc comment on CaptureDegradedReason in
// core/embed-worker.ts for why it lives there.
export type { CaptureDegradedReason };

export type CaptureResult =
  | {
      status: "captured";
      documentId: string;
      versionId: string;
      chunks: number;
      degraded?: CaptureDegradedReason[];
    }
  | { status: "noop"; documentId: string; versionId: string; chunks: 0 };

type CaptureTxResult =
  | {
      status: "captured";
      documentId: string;
      versionId: string;
      insertedChunks: EmbeddableChunk[];
    }
  | { status: "noop"; documentId: string; versionId: string };

// The caller sets what it knows on AdaptedDocument (actorCount, sourceClass,
// hasSocialSignal, all optional); anything it did not set
// defaults here rather than at the schema layer, so every capture (including
// a future caller that forgets to set a signal) always produces a
// well-formed AuthoritySignals rather than an undefined-riddled one.
//
// Ranking sourceClass (thread/channel/…) is deliberately NOT written to the
// version.source_class column — that column is data lineage
// (native|imported|derived) via lineageClass. See deriveLineageClass.
function deriveAuthoritySignals(plan: CapturePlan): AuthoritySignals {
  return {
    createdByKind: plan.document.actor?.kind ?? "system",
    actorCount: plan.document.actorCount ?? 1,
    sourceClass: plan.document.sourceClass ?? "native",
    hasSocialSignal: plan.document.hasSocialSignal ?? false,
  };
}

function deriveLineageClass(plan: CapturePlan): string {
  return plan.document.lineageClass ?? "native";
}

function deriveProvenance(plan: CapturePlan): string {
  return plan.document.provenance ?? "stated";
}

function deriveTemporalClass(plan: CapturePlan): string {
  if (plan.document.temporalClass) return plan.document.temporalClass;
  // Distilled claims default to state ranking; raw captures to event.
  if ((plan.document.provenance ?? "stated") === "inferred") return "state";
  return "event";
}

function parseOptionalDate(value: string | undefined): Date | null {
  if (!value) return null;
  return new Date(value);
}

async function insertVersion(
  tx: Tx,
  input: CaptureInput,
  documentId: string,
  plan: CapturePlan,
  opts: {
    version: number;
    supersedesVersionId: string | null;
    now: Date;
    rawCaptureId: string;
    generation: string;
  },
): Promise<string> {
  const versionId = newId("kver");
  const authoritySignals = deriveAuthoritySignals(plan);
  await tx.insert(memoryVersion).values({
    id: versionId,
    tenantId: input.tenantId,
    documentId,
    version: opts.version,
    supersedesVersionId: opts.supersedesVersionId,
    status: "active",
    contentHash: plan.contentHash,
    occurredAt: new Date(input.occurredAt),
    ingestedAt: opts.now,
    createdByPrincipalId: plan.document.actor?.principalId ?? null,
    createdByKind: authoritySignals.createdByKind,
    generatorAgentId: plan.document.actor?.agentId ?? null,
    authority: computeAuthority(authoritySignals),
    actorCount: authoritySignals.actorCount,
    hasSocialSignal: authoritySignals.hasSocialSignal,
    sourceClass: deriveLineageClass(plan),
    provenance: deriveProvenance(plan),
    temporalClass: deriveTemporalClass(plan),
    validFrom: parseOptionalDate(plan.document.validFrom),
    validUntil: parseOptionalDate(plan.document.validUntil),
    rawCaptureId: opts.rawCaptureId,
    generation: opts.generation,
  });
  return versionId;
}

// The raw-capture layer — the raw corpus: the exact incoming /capture payload, hashed and
// persisted immutably BEFORE derivation so a later replay can re-derive
// under a different config without re-fetching source. sourceHash is the
// dedupe key (tenantId, sourceHash uniq index): an identical re-capture
// (same adapter/occurredAt/document, byte for byte) reuses the existing
// raw_capture row rather than inserting a duplicate — the table is
// append-only.
function computeSourceHash(input: CaptureInput): string {
  const canonical = stableStringify({
    adapter: input.adapter,
    occurredAt: input.occurredAt,
    document: input.document,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// A plain SELECT-then-INSERT here would race: two concurrent identical
// captures can both pass the SELECT before either INSERT lands, then both
// attempt the INSERT, and the loser hits `raw_capture_tenant_source_hash_uniq`
// with an uncaught unique-violation — surfaced as an unhandled 500 for what
// should be an idempotent, retry-safe capture. `INSERT ... ON CONFLICT DO
// NOTHING` makes the dedupe atomic: the loser's insert is silently skipped
// (an empty `RETURNING`, never an error) rather than raising, and it then
// reads back the winner's already-committed row.
async function insertOrReuseRawCapture(
  tx: Tx,
  input: CaptureInput,
  now: Date,
): Promise<string> {
  const sourceHash = computeSourceHash(input);
  const rawCaptureId = newId("kraw");

  const insertedRows = await tx
    .insert(rawCapture)
    .values({
      id: rawCaptureId,
      tenantId: input.tenantId,
      adapter: input.adapter,
      externalRef: input.document.externalRef,
      fetchedAt: now,
      contentType: "application/json",
      rawText: JSON.stringify({
        adapter: input.adapter,
        occurredAt: input.occurredAt,
        document: input.document,
      }),
      metadata: { occurredAt: input.occurredAt },
      sourceHash,
    })
    .onConflictDoNothing({
      target: [rawCapture.tenantId, rawCapture.sourceHash],
    })
    .returning({ id: rawCapture.id });
  const inserted = insertedRows[0];
  if (inserted) return inserted.id;

  const existingRows = await tx
    .select({ id: rawCapture.id })
    .from(rawCapture)
    .where(
      and(
        eq(rawCapture.tenantId, input.tenantId),
        eq(rawCapture.sourceHash, sourceHash),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw new Error(
      `raw_capture insert conflicted on (tenant_id, source_hash) but no existing row was found for tenant ${input.tenantId}`,
    );
  }
  return existing.id;
}

// No unique constraint backs memory_entity — dedupe here on an exact
// (tenantId, kind, identifiers) match, matching what a caller re-emits for
// the same real-world thing across captures. Returns the entity id (existing
// or freshly inserted) so edge resolution can point at it.
async function upsertEntity(
  tx: Tx,
  tenantId: string,
  hint: EntityHint,
  now: Date,
): Promise<string> {
  const identifiers = { value: hint.identifier };
  const rows = await tx
    .select({
      id: memoryEntity.id,
      identifiers: memoryEntity.identifiers,
    })
    .from(memoryEntity)
    .where(
      and(
        eq(memoryEntity.tenantId, tenantId),
        eq(memoryEntity.kind, hint.kind),
      ),
    );
  const match = rows.find(
    (r) => JSON.stringify(r.identifiers) === JSON.stringify(identifiers),
  );
  if (match) return match.id;
  const id = newId("kent");
  await tx.insert(memoryEntity).values({
    id,
    tenantId,
    kind: hint.kind,
    identifiers,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// No unique constraint backs memory_edge either — dedupe on the full
// (tenantId, rel, from, to) tuple so re-ingesting the same document doesn't
// pile up duplicate relationship rows across versions.
//
// Adapter-facing `native` endpoints are planning-time hints for principals
// (or other non-entity refs). Resolve them to a memory_entity row before
// insert so the DB CHECK (document|version|chunk|entity) is always satisfied.
async function upsertEdge(
  tx: Tx,
  tenantId: string,
  documentId: string,
  hint: MemoryEdgeHint,
  now: Date,
): Promise<void> {
  let toType = hint.to.type;
  let toRef = hint.to.ref;
  if (toType === "native") {
    toRef = await upsertEntity(
      tx,
      tenantId,
      { kind: "principal", identifier: toRef },
      now,
    );
    toType = "entity";
  }

  const rows = await tx
    .select({ id: memoryEdge.id })
    .from(memoryEdge)
    .where(
      and(
        eq(memoryEdge.tenantId, tenantId),
        eq(memoryEdge.rel, hint.rel),
        eq(memoryEdge.fromType, "document"),
        eq(memoryEdge.fromRef, documentId),
        eq(memoryEdge.toType, toType),
        eq(memoryEdge.toRef, toRef),
      ),
    )
    .limit(1);
  if (rows[0]) return;
  await tx.insert(memoryEdge).values({
    id: newId("kedg"),
    tenantId,
    rel: hint.rel,
    fromType: "document",
    fromRef: documentId,
    toType,
    toRef,
    createdAt: now,
  });
}

// Chunks are never reused across versions (deep-storage-versioning.md §3.3),
// so this always inserts fresh rows scoped to the new versionId. Entity/edge
// hints are best-effort graph enrichment, upserted independent of version.
// Returns the freshly-inserted chunk rows (id + text) so the caller can embed
// them after the transaction commits.
async function insertChunksAndGraph(
  tx: Tx,
  tenantId: string,
  documentId: string,
  versionId: string,
  plan: CapturePlan,
  now: Date,
): Promise<EmbeddableChunk[]> {
  const chunkIds = plan.chunks.map(() => newId("kchk"));
  const insertedChunks: EmbeddableChunk[] = plan.chunks.map((chunk, i) => ({
    id: chunkIds[i] as string,
    text: chunk.text,
  }));

  if (plan.chunks.length > 0) {
    await tx.insert(memoryChunk).values(
      plan.chunks.map((chunk, i) => ({
        id: chunkIds[i] as string,
        tenantId,
        versionId,
        documentId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        role: chunk.role ?? null,
        createdAt: now,
      })),
    );
  }

  for (const hint of plan.entityHints) {
    await upsertEntity(tx, tenantId, hint, now);
  }

  for (const edgeHint of plan.edges) {
    await upsertEdge(tx, tenantId, documentId, edgeHint, now);
  }

  return insertedChunks;
}

// The replay pipeline's single derivation core: adaptAndPlan's output → doc
// upsert → version(+authority) → chunks → edges, scoped to a target
// `generation`. The live /capture path calls this with generation='live'
// and a freshly-inserted-or-reused raw_capture id (captureInTransaction,
// below); a replay (transform.ts) calls it directly with an EXISTING
// raw_capture id and its own run id as the generation, targeting the same
// (tenant, adapter, externalRef) document row but never reading or writing
// another generation's versions — the active-version lookup below is scoped
// by (documentId, generation), matching the (document_id, generation,
// version) uniqueness the 0009 migration establishes.
async function deriveVersionInTransaction(
  tx: Tx,
  input: CaptureInput,
  plan: CapturePlan,
  now: Date,
  rawCaptureId: string,
  generation: string,
): Promise<CaptureTxResult> {
  const doc = plan.document;
  const existingRows = await tx
    .select()
    .from(memoryDocument)
    .where(
      and(
        eq(memoryDocument.tenantId, input.tenantId),
        eq(memoryDocument.adapter, input.adapter),
        eq(memoryDocument.externalRef, doc.externalRef),
      ),
    )
    .limit(1);
  const existingDoc = existingRows[0] ?? null;

  if (!existingDoc) {
    const documentId = newId("kdoc");
    // accessTags is the security boundary for document access.
    await tx.insert(memoryDocument).values({
      id: documentId,
      tenantId: input.tenantId,
      kind: doc.kind,
      title: doc.title,
      adapter: input.adapter,
      externalRef: doc.externalRef,
      accessTags: doc.accessTags,
      attributes: doc.attributes ?? {},
      createdAt: now,
      lastSeenAt: now,
    });

    const versionId = await insertVersion(tx, input, documentId, plan, {
      version: 1,
      supersedesVersionId: null,
      now,
      rawCaptureId,
      generation,
    });
    const insertedChunks = await insertChunksAndGraph(
      tx,
      input.tenantId,
      documentId,
      versionId,
      plan,
      now,
    );
    return { status: "captured", documentId, versionId, insertedChunks };
  }

  const activeVersionRows = await tx
    .select()
    .from(memoryVersion)
    .where(
      and(
        eq(memoryVersion.documentId, existingDoc.id),
        eq(memoryVersion.generation, generation),
        eq(memoryVersion.status, "active"),
      ),
    )
    .orderBy(desc(memoryVersion.version))
    .limit(1);
  const activeVersion = activeVersionRows[0] ?? null;

  if (activeVersion && activeVersion.contentHash === plan.contentHash) {
    await tx
      .update(memoryDocument)
      .set({ lastSeenAt: now })
      .where(eq(memoryDocument.id, existingDoc.id));
    return {
      status: "noop",
      documentId: existingDoc.id,
      versionId: activeVersion.id,
    };
  }

  if (activeVersion) {
    await tx
      .update(memoryVersion)
      .set({ status: "superseded" })
      .where(eq(memoryVersion.id, activeVersion.id));
  }

  const versionId = await insertVersion(tx, input, existingDoc.id, plan, {
    version: (activeVersion?.version ?? 0) + 1,
    supersedesVersionId: activeVersion?.id ?? null,
    now,
    rawCaptureId,
    generation,
  });

  await tx
    .update(memoryDocument)
    .set({
      title: doc.title,
      accessTags: doc.accessTags,
      attributes: doc.attributes ?? {},
      lastSeenAt: now,
    })
    .where(eq(memoryDocument.id, existingDoc.id));

  const insertedChunks = await insertChunksAndGraph(
    tx,
    input.tenantId,
    existingDoc.id,
    versionId,
    plan,
    now,
  );

  return {
    status: "captured",
    documentId: existingDoc.id,
    versionId,
    insertedChunks,
  };
}

async function captureInTransaction(
  tx: Tx,
  input: CaptureInput,
  plan: CapturePlan,
  now: Date,
): Promise<CaptureTxResult> {
  const rawCaptureId = await insertOrReuseRawCapture(tx, input, now);
  return deriveVersionInTransaction(
    tx,
    input,
    plan,
    now,
    rawCaptureId,
    LIVE_GENERATION,
  );
}

// Re-exported so tests can assert the capture path resolves its embed
// client config through the one shared mapping (see engine-client-config.ts)
// rather than a capture-local duplicate that could drop fields like timeoutMs.
export { toEmbedClientConfig };

// Embeds a version's freshly-inserted chunks and stores their vectors, after
// the derivation transaction has already committed. Best-effort in the
// fullest sense: ANY failure here — including ensure/activateEmbedModel's
// dims-probe network call, not just embedChunks' own client-error/rejected-
// chunk cases — is caught, logged, and swallowed. The chunk rows are already
// durable, and a later re-embed pass can pick up anything left unembedded
// (mirrors embed-worker.ts's pending-chunk contract, just invoked eagerly
// here instead of by polling). Returns whether embedding degraded so the
// caller can surface it.
//
// `promoteActive` (default true): live capture activates the model so dense
// search targets it. Replay must pass false so ensureEmbedModel only creates
// the table without flipping the tenant's active embed model (CL-5872).
//
// `embedClientConfig` is `undefined` when the engine has no embed endpoint
// configured at all (a lexical-only deployment) — chunks are already durable
// from the capture transaction, so this returns
// `degraded: ["embed_unavailable", "lexical_only"]` (unvectorized, the same
// pairing search's `degraded` uses for the same "configured off" state)
// WITHOUT touching the embed-model registry (`ensureEmbedModel`/
// `activateEmbedModel`): there is no endpoint to probe dims against, and
// probing one that doesn't exist is exactly the doomed-call this feature
// exists to skip. Every other failure path here (client error, rejected
// chunks, an unexpected throw) reports `["embed_unavailable"]` alone — the
// endpoint IS configured, this specific pass just didn't land.
//
// Exported (like toEmbedClientConfig above) so tests can assert this
// specific decision directly, without standing up a fake transactional Db
// for the full captureDocument/deriveFromRawCapture path.
//
// `opts.fetchImpl` (default `fetch`) is the HTTP implementation the registry
// probe and the embed calls run through — captureDocument's background pass
// forwards its own here so a test (or host) can observe or stub the wire.
export async function embedInsertedChunksWithConfig(
  sql: RawSql,
  tenantId: string,
  chunks: EmbeddableChunk[],
  embedClientConfig: EmbedClientConfig | undefined,
  opts: { promoteActive?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ degraded: CaptureDegradedReason[] }> {
  if (chunks.length === 0) return { degraded: [] };
  if (!embedClientConfig) {
    return { degraded: ["embed_unavailable", "lexical_only"] };
  }

  try {
    const client = createRawSqlClient(sql);
    const promoteActive = opts.promoteActive !== false;
    const fetchImpl = opts.fetchImpl ?? fetch;

    const table = promoteActive
      ? await activateEmbedModel(client, tenantId, embedClientConfig, fetchImpl)
      : await ensureEmbedModel(client, tenantId, embedClientConfig, fetchImpl);

    const result = await embedChunks(
      client,
      tenantId,
      table,
      chunks,
      embedClientConfig,
      fetchImpl,
    );

    if (result.clientError) {
      log.warn(
        `capture: embedding client failed; chunks remain pending: ${result.clientError}`,
        { tenantId, chunkCount: chunks.length, error: result.clientError },
      );
      return { degraded: ["embed_unavailable"] };
    }
    if (result.rejected.length > 0) {
      log.warn(
        `capture: ${result.rejected.length} chunk(s) rejected during embedding`,
        { tenantId, rejected: result.rejected },
      );
      return { degraded: ["embed_unavailable"] };
    }
    return { degraded: [] };
  } catch (err) {
    const errMessage = formatCaughtError(err);
    log.warn(
      `capture: embedding pass failed; chunks remain pending: ${errMessage}`,
      { tenantId, chunkCount: chunks.length, error: errMessage },
    );
    return { degraded: ["embed_unavailable"] };
  }
}

export interface CaptureBackgroundOpts {
  /** HTTP implementation the background embed pass runs through (default `fetch`). */
  fetchImpl?: typeof fetch | undefined;
  /**
   * Schedules the detached background task. Defaults to a `queueMicrotask`
   * fire-and-forget so `captureDocument` returns as soon as the row store
   * commits. Tests inject a capturing scheduler to run the task deterministically.
   */
  schedule?: ((task: () => Promise<void>) => void) | undefined;
  /** Delay between embed retries (default `setTimeout`). Injected as no-op in tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Total embed attempts per pass stage, first try included (default 3). */
  maxAttempts?: number | undefined;
  /** Max pending chunks swept per background pass (default 100). */
  pendingLimit?: number | undefined;
}

const BACKGROUND_EMBED_MAX_ATTEMPTS = 3;
const BACKGROUND_EMBED_PENDING_LIMIT = 100;
// A busy local embedder (shared Ollama queuing chat inference ahead of
// embeddings) usually drains within seconds — retry quickly, then once more
// after a longer pause, rather than hammering it.
const BACKGROUND_EMBED_RETRY_DELAYS_MS = [1_000, 5_000];

export type BackgroundEmbedPassFn = (
  chunks: EmbeddableChunk[],
) => Promise<void>;

export type BackgroundEmbedEnqueue = {
  tenantId: string;
  chunks: readonly EmbeddableChunk[];
  run: BackgroundEmbedPassFn;
};

export type BackgroundEmbedScheduler = {
  /**
   * Queue a pass. Overlapping calls for the same tenant coalesce into the
   * in-flight drain (at most one trailing rerun); different tenants share one
   * process-wide chain so N concurrent adds never fan out N retry storms.
   */
  enqueue: (work: BackgroundEmbedEnqueue) => Promise<void>;
  /** Count of `run` invocations started (test seam). */
  passStarts: () => number;
  /** Peak overlapping `run` invocations (test seam). */
  maxConcurrent: () => number;
};

/**
 * Serial, coalescing gate for detached embed passes. One `run` at a time
 * process-wide; same-tenant chunks that arrive while a drain is queued or
 * running join that drain instead of starting another 3-retry + sweep storm.
 */
export function createBackgroundEmbedScheduler(): BackgroundEmbedScheduler {
  type TenantState = {
    chunks: EmbeddableChunk[];
    run: BackgroundEmbedPassFn;
    waiters: Array<{
      resolve: () => void;
      reject: (err: unknown) => void;
    }>;
    queued: boolean;
  };

  const tenants = new Map<string, TenantState>();
  let chain: Promise<void> = Promise.resolve();
  let passStarts = 0;
  let inRun = 0;
  let maxConcurrent = 0;

  async function drainTenant(tenantId: string): Promise<void> {
    const state = tenants.get(tenantId);
    if (!state) return;
    let error: unknown;
    try {
      for (;;) {
        const batch = state.chunks.splice(0, state.chunks.length);
        if (batch.length === 0) break;
        passStarts++;
        inRun++;
        if (inRun > maxConcurrent) maxConcurrent = inRun;
        try {
          await state.run(batch);
        } finally {
          inRun--;
        }
      }
    } catch (err) {
      error = err;
    }
    const waiters = state.waiters.splice(0, state.waiters.length);
    tenants.delete(tenantId);
    if (error !== undefined) {
      for (const waiter of waiters) waiter.reject(error);
      return;
    }
    for (const waiter of waiters) waiter.resolve();
  }

  return {
    enqueue(work) {
      let state = tenants.get(work.tenantId);
      if (!state) {
        state = { chunks: [], run: work.run, waiters: [], queued: false };
        tenants.set(work.tenantId, state);
      }
      state.chunks.push(...work.chunks);
      state.run = work.run;
      const done = new Promise<void>((resolve, reject) => {
        state.waiters.push({ resolve, reject });
      });
      if (!state.queued) {
        state.queued = true;
        const tenantId = work.tenantId;
        chain = chain.then(
          () => drainTenant(tenantId),
          () => drainTenant(tenantId),
        );
      }
      return done;
    },
    passStarts: () => passStarts,
    maxConcurrent: () => maxConcurrent,
  };
}

const backgroundEmbedScheduler = createBackgroundEmbedScheduler();

function resolveBackgroundOpts(opts: CaptureBackgroundOpts = {}): {
  fetchImpl: typeof fetch;
  schedule: (task: () => Promise<void>) => void;
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
  pendingLimit: number;
} {
  return {
    fetchImpl: opts.fetchImpl ?? fetch,
    schedule:
      opts.schedule ??
      ((task) => {
        queueMicrotask(() => void task().catch(() => {}));
      }),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    maxAttempts: opts.maxAttempts ?? BACKGROUND_EMBED_MAX_ATTEMPTS,
    pendingLimit: opts.pendingLimit ?? BACKGROUND_EMBED_PENDING_LIMIT,
  };
}

/**
 * Finds this tenant's chunks with no vector in the active embedding table —
 * the chunks a failed or timed-out embed pass left pending. Bounded by
 * `limit` (oldest first) so a long outage sweeps incrementally, one
 * background pass at a time, instead of embedding an unbounded backlog in a
 * single call.
 *
 * Joins `memory.version` so a forget-then-add cannot sweep `[redacted]`
 * placeholder text: tombstoned versions and non-live generations are skipped.
 * Search already hides tombstones; this filter is wasted-work / placeholder-
 * vector prevention, not a hit-leak fix.
 */
export async function findPendingChunks(
  client: EmbedRegistrySqlClient,
  tenantId: string,
  activeTable: ActiveEmbedTable,
  limit: number,
): Promise<EmbeddableChunk[]> {
  if (!EMBED_TABLE_NAME_PATTERN.test(activeTable.tableName)) {
    throw new Error(
      `Resolved embed table name "${activeTable.tableName}" failed identifier validation`,
    );
  }
  const rows = await client.query(
    `SELECT c.id AS id, c.text AS text FROM "memory"."chunk" c
     INNER JOIN "memory"."version" v ON v.id = c.version_id
     LEFT JOIN ${activeTable.tableName} e ON e.chunk_id = c.id
     WHERE c.tenant_id = $1 AND e.chunk_id IS NULL
       AND v.status <> 'tombstoned'
       AND v.generation = $3
     ORDER BY c.created_at ASC
     LIMIT $2`,
    [tenantId, Math.max(1, Math.floor(limit)), LIVE_GENERATION],
  );
  return rows.map((row) => ({
    id: row["id"] as string,
    text: row["text"] as string,
  }));
}

export interface ReembedPendingResult {
  /** Pending chunks newly vectorized by this sweep. */
  swept: number;
  /** Pending chunks still without a vector after this sweep. */
  stillPending: number;
}

/**
 * Re-embeds one bounded batch of pending chunks for the tenant: resolves the
 * active embed table, discovers chunks missing vectors, and embeds them.
 * Client failures leave the chunks pending and are reported via the counts,
 * never thrown — the next background pass retries. `undefined` config (a
 * lexical-only deployment) is a no-op: there is no endpoint to sweep with.
 */
export async function reembedPendingChunksWithClient(
  client: EmbedRegistrySqlClient,
  tenantId: string,
  embedClientConfig: EmbedClientConfig | undefined,
  opts: {
    promoteActive?: boolean;
    limit?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ReembedPendingResult> {
  if (!embedClientConfig) return { swept: 0, stillPending: 0 };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const promoteActive = opts.promoteActive !== false;

  const table = promoteActive
    ? await activateEmbedModel(client, tenantId, embedClientConfig, fetchImpl)
    : await ensureEmbedModel(client, tenantId, embedClientConfig, fetchImpl);
  const pending = await findPendingChunks(
    client,
    tenantId,
    table,
    opts.limit ?? BACKGROUND_EMBED_PENDING_LIMIT,
  );
  if (pending.length === 0) return { swept: 0, stillPending: 0 };

  const result = await embedChunks(
    client,
    tenantId,
    table,
    pending,
    embedClientConfig,
    fetchImpl,
  );
  if (result.clientError) {
    log.warn(
      `capture: pending re-embed failed (${pending.length} chunk(s) still pending): ${result.clientError.name}: ${result.clientError.message}`,
      { tenantId, chunkCount: pending.length, error: result.clientError },
    );
    return { swept: 0, stillPending: pending.length };
  }
  if (result.rejected.length > 0) {
    log.warn(
      `capture: ${result.rejected.length} pending chunk(s) rejected during re-embedding`,
      { tenantId, rejected: result.rejected },
    );
  }
  return {
    swept: result.embedded,
    stillPending: pending.length - result.embedded,
  };
}

export async function reembedPendingChunks(
  sql: RawSql,
  tenantId: string,
  embedClientConfig: EmbedClientConfig | undefined,
  opts: {
    promoteActive?: boolean;
    limit?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ReembedPendingResult> {
  return reembedPendingChunksWithClient(
    createRawSqlClient(sql),
    tenantId,
    embedClientConfig,
    opts,
  );
}

// One attempt at the fresh chunks, then one bounded pending sweep. Throws
// nothing — every failure is logged and reported via `degraded` so the retry
// loop (and the detached scheduler) can decide what to do next.
async function attemptBackgroundEmbedPass(args: {
  sql: RawSql;
  tenantId: string;
  chunks: EmbeddableChunk[];
  embedClientConfig: EmbedClientConfig;
  fetchImpl: typeof fetch;
  pendingLimit: number;
}): Promise<{ degraded: CaptureDegradedReason[] }> {
  const { degraded } = await embedInsertedChunksWithConfig(
    args.sql,
    args.tenantId,
    args.chunks,
    args.embedClientConfig,
    { fetchImpl: args.fetchImpl },
  );
  if (degraded.length > 0) return { degraded };
  try {
    await reembedPendingChunks(args.sql, args.tenantId, args.embedClientConfig, {
      fetchImpl: args.fetchImpl,
      limit: args.pendingLimit,
    });
  } catch (err) {
    log.warn(`capture: background pending sweep failed: ${formatCaughtError(err)}`, {
      tenantId: args.tenantId,
      error: formatCaughtError(err),
    });
  }
  return { degraded };
}

// The background embedding pass a successful capture schedules (CL-8615): the
// fresh chunks are embedded with retry, then one bounded batch of older
// pending chunks is swept, so a slow or busy embedder (a local Ollama queuing
// embeddings behind chat inference) never stalls the `add` tool call and
// never leaves chunks pending. Never throws — a detached task must not
// produce an unhandled rejection.
export async function runBackgroundEmbedPass(
  sql: RawSql,
  tenantId: string,
  chunks: EmbeddableChunk[],
  embedClientConfig: EmbedClientConfig,
  opts: CaptureBackgroundOpts = {},
): Promise<void> {
  const resolved = resolveBackgroundOpts(opts);
  const maxAttempts = Math.max(1, Math.floor(resolved.maxAttempts));
  for (let attempt = 1; ; attempt++) {
    let degraded: CaptureDegradedReason[];
    try {
      ({ degraded } = await attemptBackgroundEmbedPass({
        sql,
        tenantId,
        chunks,
        embedClientConfig,
        fetchImpl: resolved.fetchImpl,
        pendingLimit: resolved.pendingLimit,
      }));
    } catch (err) {
      log.warn(
        `capture: background embedding pass failed; chunks remain pending: ${formatCaughtError(err)}`,
        { tenantId, chunkCount: chunks.length, error: formatCaughtError(err) },
      );
      degraded = ["embed_unavailable"];
    }
    if (degraded.length === 0) return;
    if (attempt >= maxAttempts) {
      log.warn(
        `capture: background embedding pass gave up after ${attempt} attempt(s); chunks remain pending for a later pass`,
        { tenantId, chunkCount: chunks.length },
      );
      return;
    }
    const delay =
      BACKGROUND_EMBED_RETRY_DELAYS_MS[attempt - 1] ??
      BACKGROUND_EMBED_RETRY_DELAYS_MS[BACKGROUND_EMBED_RETRY_DELAYS_MS.length - 1]!;
    await resolved.sleep(delay);
  }
}

export async function captureDocument(
  deps: { db: Db; sql: RawSql; config: EngineConfig },
  input: CaptureInput,
  background: CaptureBackgroundOpts = {},
): Promise<CaptureResult> {
  const plan = adaptAndPlan(input.document);
  const now = new Date();

  const txResult = await deps.db.transaction((tx) =>
    captureInTransaction(tx, input, plan, now),
  );

  if (txResult.status === "noop") {
    return {
      status: "noop",
      documentId: txResult.documentId,
      versionId: txResult.versionId,
      chunks: 0,
    };
  }

  // CL-8615: the rows are durable — return now and embed in the background.
  // A slow or busy embedder (a local Ollama queuing embeddings behind chat
  // inference) must never stall the `add` tool call, so the embed pass runs
  // detached with retry plus a bounded pending-chunk sweep (see
  // runBackgroundEmbedPass), and failures stay in the logs rather than the
  // response. The success path therefore omits `degraded: ["embed_unavailable"]`
  // even while chunks are still pending: a captured result means the row store
  // committed, not that the embedder has caught up. The synchronous paths
  // below pay for no network: no chunks means nothing to embed, and no embed
  // endpoint (lexical-only) is decided locally without touching the registry.
  const embedClientConfig = toEmbedClientConfig(deps.config.embed);
  if (txResult.insertedChunks.length === 0 || !embedClientConfig) {
    const { degraded } = await embedInsertedChunksWithConfig(
      deps.sql,
      input.tenantId,
      txResult.insertedChunks,
      embedClientConfig,
    );

    return {
      status: "captured",
      documentId: txResult.documentId,
      versionId: txResult.versionId,
      chunks: txResult.insertedChunks.length,
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }

  const resolved = resolveBackgroundOpts(background);
  const backgroundChunks = txResult.insertedChunks;
  resolved.schedule(() =>
    backgroundEmbedScheduler.enqueue({
      tenantId: input.tenantId,
      chunks: backgroundChunks,
      run: (chunks) =>
        runBackgroundEmbedPass(deps.sql, input.tenantId, chunks, embedClientConfig, {
          fetchImpl: resolved.fetchImpl,
          sleep: resolved.sleep,
          maxAttempts: resolved.maxAttempts,
          pendingLimit: resolved.pendingLimit,
        }),
    }),
  );

  return {
    status: "captured",
    documentId: txResult.documentId,
    versionId: txResult.versionId,
    chunks: txResult.insertedChunks.length,
  };
}

// The replay pipeline's entrypoint (transform.ts): re-derives ONE raw_capture
// row's already-parsed payload under `generation` (a transform_run id),
// reusing the config's own chunker/embed knobs instead of the engine's
// defaults. `rawCaptureId` must already exist (a replay never writes a new
// raw_capture row — the raw-capture layer's append-only corpus is read-only from here).
export async function deriveFromRawCapture(
  deps: { db: Db; sql: RawSql },
  input: CaptureInput,
  rawCaptureId: string,
  generation: string,
  derivation: { chunker?: AdaptAndPlanOptions["chunker"]; embed: EmbedClientConfig },
): Promise<CaptureResult> {
  const plan = adaptAndPlan(
    input.document,
    derivation.chunker !== undefined ? { chunker: derivation.chunker } : {},
  );
  const now = new Date();

  const txResult = await deps.db.transaction((tx) =>
    deriveVersionInTransaction(tx, input, plan, now, rawCaptureId, generation),
  );

  if (txResult.status === "noop") {
    return {
      status: "noop",
      documentId: txResult.documentId,
      versionId: txResult.versionId,
      chunks: 0,
    };
  }

  const { degraded } = await embedInsertedChunksWithConfig(
    deps.sql,
    input.tenantId,
    txResult.insertedChunks,
    derivation.embed,
    // Replay never flips the tenant's active embed model.
    { promoteActive: false },
  );

  return {
    status: "captured",
    documentId: txResult.documentId,
    versionId: txResult.versionId,
    chunks: txResult.insertedChunks.length,
    ...(degraded.length > 0 ? { degraded } : {}),
  };
}
