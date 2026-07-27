import { type } from "arktype";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db, RawSql } from "../db/client.ts";
import type { EngineConfig } from "../config.ts";
import { newId } from "../core/id.ts";
import { formatCaughtError, log } from "../log.ts";
import { stableStringify } from "../core/hash.ts";
import { LIVE_GENERATION } from "../core/generation.ts";
import {
  knowledgeChunk,
  knowledgeDocument,
  knowledgeEdge,
  knowledgeEntity,
  knowledgeVersion,
  rawCapture,
} from "../db/schema.ts";
import {
  adaptAndPlan,
  type AdaptAndPlanOptions,
  type CapturePlan,
} from "../core/adapt-and-plan.ts";
import { computeAuthority, type AuthoritySignals } from "../core/authority.ts";
import type {
  AdaptedDocument,
  EntityHint,
} from "../core/schemas/adapted-document.ts";
import type { KnowledgeEdgeHint } from "../core/schemas/entity-edge.ts";
import { createEmbedRegistrySqlClient } from "../core/embed-sql.ts";
import { activateEmbedModel } from "../core/embed-model-registry.ts";
import { EmbedClientConfigSchema, type EmbedClientConfig } from "../core/embed-client.ts";
import { embedChunks, type EmbeddableChunk } from "../core/embed-worker.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The single doorway a caller uses to reach the knowledge store: parses an
// already-adapted document into a capture plan (adaptAndPlan), writes
// document/version/chunk/edge rows in one transaction, then embeds the
// version's chunks after commit. Unlike a fire-and-forget capture hook, this
// IS the primary write the HTTP caller is waiting on — a real DB failure is
// allowed to throw (fail loud) rather than being swallowed into a
// `{status: "failed"}` result.
export type CaptureInput = {
  tenantId: string;
  adapter: string;
  occurredAt: string;
  document: AdaptedDocument;
};

export type CaptureResult =
  | {
      status: "captured";
      documentId: string;
      versionId: string;
      chunks: number;
      degraded?: boolean;
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
function deriveAuthoritySignals(plan: CapturePlan): AuthoritySignals {
  return {
    createdByKind: plan.document.actor?.kind ?? "system",
    actorCount: plan.document.actorCount ?? 1,
    sourceClass: plan.document.sourceClass ?? "native",
    hasSocialSignal: plan.document.hasSocialSignal ?? false,
  };
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
  await tx.insert(knowledgeVersion).values({
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
    sourceClass: authoritySignals.sourceClass,
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

// No unique constraint backs knowledge_entity — dedupe here on an exact
// (tenantId, kind, identifiers) match, matching what a caller re-emits for
// the same real-world thing across captures.
async function upsertEntity(
  tx: Tx,
  tenantId: string,
  hint: EntityHint,
  now: Date,
): Promise<void> {
  const identifiers = { value: hint.identifier };
  const rows = await tx
    .select({
      id: knowledgeEntity.id,
      identifiers: knowledgeEntity.identifiers,
    })
    .from(knowledgeEntity)
    .where(
      and(
        eq(knowledgeEntity.tenantId, tenantId),
        eq(knowledgeEntity.kind, hint.kind),
      ),
    );
  const exists = rows.some(
    (r) => JSON.stringify(r.identifiers) === JSON.stringify(identifiers),
  );
  if (exists) return;
  await tx.insert(knowledgeEntity).values({
    id: newId("kent"),
    tenantId,
    kind: hint.kind,
    identifiers,
    createdAt: now,
    updatedAt: now,
  });
}

// No unique constraint backs knowledge_edge either — dedupe on the full
// (tenantId, rel, from, to) tuple so re-ingesting the same document doesn't
// pile up duplicate relationship rows across versions.
async function upsertEdge(
  tx: Tx,
  tenantId: string,
  documentId: string,
  hint: KnowledgeEdgeHint,
  now: Date,
): Promise<void> {
  const rows = await tx
    .select({ id: knowledgeEdge.id })
    .from(knowledgeEdge)
    .where(
      and(
        eq(knowledgeEdge.tenantId, tenantId),
        eq(knowledgeEdge.rel, hint.rel),
        eq(knowledgeEdge.fromType, "document"),
        eq(knowledgeEdge.fromRef, documentId),
        eq(knowledgeEdge.toType, hint.to.type),
        eq(knowledgeEdge.toRef, hint.to.ref),
      ),
    )
    .limit(1);
  if (rows[0]) return;
  await tx.insert(knowledgeEdge).values({
    id: newId("kedg"),
    tenantId,
    rel: hint.rel,
    fromType: "document",
    fromRef: documentId,
    toType: hint.to.type,
    toRef: hint.to.ref,
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
    await tx.insert(knowledgeChunk).values(
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
    .from(knowledgeDocument)
    .where(
      and(
        eq(knowledgeDocument.tenantId, input.tenantId),
        eq(knowledgeDocument.adapter, input.adapter),
        eq(knowledgeDocument.externalRef, doc.externalRef),
      ),
    )
    .limit(1);
  const existingDoc = existingRows[0] ?? null;

  if (!existingDoc) {
    const documentId = newId("kdoc");
    await tx.insert(knowledgeDocument).values({
      id: documentId,
      tenantId: input.tenantId,
      kind: doc.kind,
      title: doc.title,
      adapter: input.adapter,
      externalRef: doc.externalRef,
      visibilityMode: doc.visibility.mode,
      visibilityPrincipalIds: doc.visibility.principalIds ?? null,
      visibilitySourceAcl: doc.visibility.sourceAcl ?? null,
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
    .from(knowledgeVersion)
    .where(
      and(
        eq(knowledgeVersion.documentId, existingDoc.id),
        eq(knowledgeVersion.generation, generation),
        eq(knowledgeVersion.status, "active"),
      ),
    )
    .orderBy(desc(knowledgeVersion.version))
    .limit(1);
  const activeVersion = activeVersionRows[0] ?? null;

  if (activeVersion && activeVersion.contentHash === plan.contentHash) {
    await tx
      .update(knowledgeDocument)
      .set({ lastSeenAt: now })
      .where(eq(knowledgeDocument.id, existingDoc.id));
    return {
      status: "noop",
      documentId: existingDoc.id,
      versionId: activeVersion.id,
    };
  }

  if (activeVersion) {
    await tx
      .update(knowledgeVersion)
      .set({ status: "superseded" })
      .where(eq(knowledgeVersion.id, activeVersion.id));
  }

  const versionId = await insertVersion(tx, input, existingDoc.id, plan, {
    version: (activeVersion?.version ?? 0) + 1,
    supersedesVersionId: activeVersion?.id ?? null,
    now,
    rawCaptureId,
    generation,
  });

  await tx
    .update(knowledgeDocument)
    .set({
      title: doc.title,
      visibilityMode: doc.visibility.mode,
      visibilityPrincipalIds: doc.visibility.principalIds ?? null,
      visibilitySourceAcl: doc.visibility.sourceAcl ?? null,
      attributes: doc.attributes ?? {},
      lastSeenAt: now,
    })
    .where(eq(knowledgeDocument.id, existingDoc.id));

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

// Built from the engine's own operator-configured embed endpoint — a trusted
// URL, the same as KNOWLEDGE_DATABASE_URL.
function toEmbedClientConfig(embed: EngineConfig["embed"]): EmbedClientConfig {
  const candidate = {
    baseUrl: embed.baseUrl,
    modelId: embed.model,
    apiStyle: embed.apiStyle,
    ...(embed.apiKey !== undefined ? { apiKey: embed.apiKey } : {}),
  };
  const parsed = EmbedClientConfigSchema(candidate);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid embed client config: ${parsed.summary}`);
  }
  return parsed;
}

// Embeds a version's freshly-inserted chunks and stores their vectors, after
// the derivation transaction has already committed. Best-effort in the
// fullest sense: ANY failure here — including activateEmbedModel's dims-probe
// network call, not just embedChunks' own client-error/rejected-chunk cases —
// is caught, logged, and swallowed. The chunk rows are already durable, and a
// later re-embed pass can pick up anything left unembedded (mirrors
// embed-worker.ts's pending-chunk contract, just invoked eagerly here instead
// of by polling). Returns whether embedding degraded so the caller can surface
// it. Shared by the live /capture path and a replay — the only difference
// between them is which `EmbedClientConfig` is passed in.
async function embedInsertedChunksWithConfig(
  sql: RawSql,
  tenantId: string,
  chunks: EmbeddableChunk[],
  embedClientConfig: EmbedClientConfig,
): Promise<{ degraded: boolean }> {
  if (chunks.length === 0) return { degraded: false };

  try {
    const client = createEmbedRegistrySqlClient(sql);

    const activeTable = await activateEmbedModel(
      client,
      tenantId,
      embedClientConfig,
    );

    const result = await embedChunks(
      client,
      tenantId,
      activeTable,
      chunks,
      embedClientConfig,
    );

    if (result.clientError) {
      log.warn(
        `capture: embedding client failed; chunks remain pending: ${result.clientError}`,
        { tenantId, chunkCount: chunks.length, error: result.clientError },
      );
      return { degraded: true };
    }
    if (result.rejected.length > 0) {
      log.warn(
        `capture: ${result.rejected.length} chunk(s) rejected during embedding`,
        { tenantId, rejected: result.rejected },
      );
      return { degraded: true };
    }
    return { degraded: false };
  } catch (err) {
    const errMessage = formatCaughtError(err);
    log.warn(
      `capture: embedding pass failed; chunks remain pending: ${errMessage}`,
      { tenantId, chunkCount: chunks.length, error: errMessage },
    );
    return { degraded: true };
  }
}

export async function captureDocument(
  deps: { db: Db; sql: RawSql; config: EngineConfig },
  input: CaptureInput,
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

  const { degraded } = await embedInsertedChunksWithConfig(
    deps.sql,
    input.tenantId,
    txResult.insertedChunks,
    toEmbedClientConfig(deps.config.embed),
  );

  return {
    status: "captured",
    documentId: txResult.documentId,
    versionId: txResult.versionId,
    chunks: txResult.insertedChunks.length,
    ...(degraded ? { degraded: true } : {}),
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
  );

  return {
    status: "captured",
    documentId: txResult.documentId,
    versionId: txResult.versionId,
    chunks: txResult.insertedChunks.length,
    ...(degraded ? { degraded: true } : {}),
  };
}
