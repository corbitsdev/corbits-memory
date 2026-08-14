import { type } from "arktype";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db, RawSql } from "../db/client.ts";
import type { EngineConfig } from "../config.ts";
import { newId } from "../core/id.ts";
import { formatCaughtError, log } from "../log.ts";
import {
  rawCapture,
  transformConfig,
  transformRun,
} from "../db/schema.ts";
import {
  TransformConfigParamsSchema,
  type TransformConfigParams,
  type TransformRerankParams,
  type TransformScope,
} from "../core/schemas/transform.ts";
import { AdaptedDocumentSchema } from "../core/schemas/adapted-document.ts";
import { chunkTokenRecursive } from "../core/chunk/token-recursive.ts";
import type { Chunker } from "../core/chunk/types.ts";
import { EmbedClientConfigSchema, type EmbedClientConfig } from "../core/embed-client.ts";
import type { RerankClientConfig } from "../core/rerank-client.ts";
import { deriveFromRawCapture, type CaptureInput } from "./capture.ts";
import { LIVE_GENERATION } from "../core/generation.ts";
import { activateEmbedModel, activateEmbedModelByKey, clearActiveEmbedModels, resolveActiveEmbedTable } from "../core/embed-model-registry.ts";
import { createRawSqlClient } from "../core/embed-sql.ts";

export class TransformConfigNotFoundError extends Error {
  constructor(configId: string) {
    super(`transform_config not found: ${configId}`);
    this.name = "TransformConfigNotFoundError";
  }
}

export interface TransformConfigRow {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  params: TransformConfigParams;
  createdAt: Date;
}

export interface TransformRunRow {
  id: string;
  tenantId: string;
  configId: string;
  scope: TransformScope;
  generation: string;
  status: "running" | "completed" | "failed";
  rawCount: number;
  versionCount: number;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  archivedLiveGeneration: string | null;
  archivedLiveModelKey: string | null;
  promotedAt: Date | null;
}

// Parses the jsonb `params` column at this trust boundary — the row was
// written by createTransformConfig (already validated), but a boundary read
// never trusts its own storage layer implicitly.
function parseConfigParams(raw: unknown): TransformConfigParams {
  const parsed = TransformConfigParamsSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Corrupt transform_config.params: ${parsed.summary}`);
  }
  return parsed;
}

export async function createTransformConfig(
  deps: { db: Db },
  input: { tenantId: string; name: string; params: TransformConfigParams },
): Promise<TransformConfigRow> {
  const existingVersions = await deps.db
    .select({ version: transformConfig.version })
    .from(transformConfig)
    .where(
      and(
        eq(transformConfig.tenantId, input.tenantId),
        eq(transformConfig.name, input.name),
      ),
    )
    .orderBy(desc(transformConfig.version))
    .limit(1);
  const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

  const id = newId("tcfg");
  const createdAt = new Date();
  await deps.db.insert(transformConfig).values({
    id,
    tenantId: input.tenantId,
    name: input.name,
    version: nextVersion,
    params: input.params,
    createdAt,
  });

  return {
    id,
    tenantId: input.tenantId,
    name: input.name,
    version: nextVersion,
    params: input.params,
    createdAt,
  };
}

export async function listTransformConfigs(
  deps: { db: Db },
  tenantId: string,
): Promise<TransformConfigRow[]> {
  const rows = await deps.db
    .select()
    .from(transformConfig)
    .where(eq(transformConfig.tenantId, tenantId))
    .orderBy(desc(transformConfig.createdAt));

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    version: row.version,
    params: parseConfigParams(row.params),
    createdAt: row.createdAt,
  }));
}

async function loadTransformConfig(
  db: Db,
  configId: string,
): Promise<TransformConfigRow> {
  const rows = await db
    .select()
    .from(transformConfig)
    .where(eq(transformConfig.id, configId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new TransformConfigNotFoundError(configId);
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    version: row.version,
    params: parseConfigParams(row.params),
    createdAt: row.createdAt,
  };
}

async function loadTransformRun(
  db: Db,
  runId: string,
): Promise<TransformRunRow> {
  const rows = await db
    .select()
    .from(transformRun)
    .where(eq(transformRun.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`transform_run vanished mid-run: ${runId}`);
  return {
    id: row.id,
    tenantId: row.tenantId,
    configId: row.configId,
    scope: (row.scope ?? {}) as TransformScope,
    generation: row.generation,
    status: row.status as TransformRunRow["status"],
    rawCount: row.rawCount,
    versionCount: row.versionCount,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    archivedLiveGeneration: row.archivedLiveGeneration ?? null,
    archivedLiveModelKey: row.archivedLiveModelKey ?? null,
    promotedAt: row.promotedAt ?? null,
  };
}

// The only chunk strategy adaptAndPlan supports today is token.recursive
// (adapt-and-plan.ts / chunk/token-recursive.ts) — a replay overrides its
// caps from the config, ignoring whatever caps adaptAndPlan's rechunk()
// passes in (it always passes DEFAULT_CHUNK_CAPS regardless of chunker),
// which is exactly why the live path (no injected chunker) is unaffected.
function buildChunker(params: TransformConfigParams["chunk"]): Chunker {
  return (text) =>
    chunkTokenRecursive(text, {
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(params.minTokens !== undefined ? { minTokens: params.minTokens } : {}),
      ...(params.overlapTokens !== undefined
        ? { overlapTokens: params.overlapTokens }
        : {}),
    });
}

// A replay's embed endpoint is a PARTIAL override of the engine's own embed
// config: any field the transform_config omits inherits the engine's, so the
// common replays — a new model, a different endpoint, a context-window /
// chunking change, any tuning tweak — name only what changes. An embed
// endpoint is just a URL + capability options, trusted the same as the
// engine's own embed endpoint and DATABASE_URL — self-hosted or managed makes
// no difference.
function buildEmbedClientConfig(
  params: TransformConfigParams["embed"],
  engineEmbed: EngineConfig["embed"],
): EmbedClientConfig {
  const apiKey = params?.apiKey ?? engineEmbed.apiKey;
  const candidate = {
    baseUrl: params?.baseUrl ?? engineEmbed.baseUrl,
    modelId: params?.model ?? engineEmbed.model,
    apiStyle: params?.apiStyle ?? engineEmbed.apiStyle,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
  const parsed = EmbedClientConfigSchema(candidate);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid replay embed client config: ${parsed.summary}`);
  }
  return parsed;
}

// Only the fields hybridSearch actually needs to build a RerankClientConfig
// are exposed here; apiStyle defaults to 'tei' when the config omits it,
// mirroring toRerankClientConfig's engine-config precedent (search.ts).
export function buildRerankClientConfig(
  params: TransformRerankParams | undefined,
): RerankClientConfig | undefined {
  if (!params?.baseUrl) return undefined;
  return {
    baseUrl: params.baseUrl,
    apiStyle: params.apiStyle ?? "tei",
    ...(params.model !== undefined ? { model: params.model } : {}),
  };
}

export interface GenerationSearchParams {
  authorityWeight: number | undefined;
  recencyHalfLifeDays: number | undefined;
  mmrLambda: number | undefined;
  overfetch: number | undefined;
  rerank: RerankClientConfig | undefined;
  /** Fully-resolved embed client for this generation's transform_config. */
  embed: EmbedClientConfig | undefined;
}

// Resolves a search-time `generation` (a transform_run id, per the 1:1
// `transform_run.generation` uniqueness) back to its config's tuning knobs.
// Returns `null` when the generation isn't a known replay run for this tenant
// (including 'live', which the caller should never even ask this for) —
// hybridSearch falls back to its own engine defaults for every field in that
// case. Tenant is required so a cross-tenant generation id cannot resolve
// another tenant's embed overrides (which may carry apiKey).
//
// `engineEmbed` is required to fully resolve a partial transform embed
// override (same merge rules as runTransform).
export async function resolveGenerationSearchParams(
  db: Db,
  generation: string,
  engineEmbed: EngineConfig["embed"] | undefined,
  tenantId: string,
): Promise<GenerationSearchParams | null> {
  const runRows = await db
    .select({ configId: transformRun.configId })
    .from(transformRun)
    .where(
      and(
        eq(transformRun.generation, generation),
        eq(transformRun.tenantId, tenantId),
      ),
    )
    .limit(1);
  const run = runRows[0];
  if (!run) return null;

  const configRows = await db
    .select({ params: transformConfig.params })
    .from(transformConfig)
    .where(
      and(
        eq(transformConfig.id, run.configId),
        eq(transformConfig.tenantId, tenantId),
      ),
    )
    .limit(1);
  const configRow = configRows[0];
  if (!configRow) return null;

  const params = parseConfigParams(configRow.params);
  const embed =
    engineEmbed !== undefined
      ? buildEmbedClientConfig(params.embed, engineEmbed)
      : undefined;
  return {
    authorityWeight: params.authorityWeight,
    recencyHalfLifeDays: params.recencyHalfLifeDays,
    mmrLambda: params.mmrLambda,
    overfetch: params.overfetch,
    rerank: buildRerankClientConfig(params.rerank),
    embed,
  };
}

interface RawCaptureRow {
  id: string;
  adapter: string;
  rawText: string | null;
}

async function selectRawCaptureRows(
  db: Db,
  tenantId: string,
  scope: TransformScope,
): Promise<RawCaptureRow[]> {
  const conditions = [eq(rawCapture.tenantId, tenantId)];
  if (scope.adapter !== undefined) {
    conditions.push(eq(rawCapture.adapter, scope.adapter));
  }
  if (scope.since !== undefined) {
    conditions.push(gte(rawCapture.fetchedAt, new Date(scope.since)));
  }
  if (scope.until !== undefined) {
    conditions.push(lte(rawCapture.fetchedAt, new Date(scope.until)));
  }

  return db
    .select({
      id: rawCapture.id,
      adapter: rawCapture.adapter,
      rawText: rawCapture.rawText,
    })
    .from(rawCapture)
    .where(and(...conditions));
}

const RawCapturePayloadSchema = type({
  adapter: "string",
  occurredAt: "string",
  document: AdaptedDocumentSchema,
});

// Re-parses a raw_capture row's stored payload back into a CaptureInput.
// The payload was written verbatim by insertOrReuseRawCapture (capture.ts)
// from an already-validated CaptureRequestSchema body, but re-hydrating from
// storage is its own trust boundary — never trust a JSON.parse blindly.
function parseRawCapturePayload(
  tenantId: string,
  row: RawCaptureRow,
): CaptureInput {
  if (row.rawText === null) {
    throw new Error(`raw_capture ${row.id} has no raw_text to replay`);
  }
  const json: unknown = JSON.parse(row.rawText);
  const parsed = RawCapturePayloadSchema(json);
  if (parsed instanceof type.errors) {
    throw new Error(
      `raw_capture ${row.id} failed to parse for replay: ${parsed.summary}`,
    );
  }
  return {
    tenantId,
    adapter: parsed.adapter,
    occurredAt: parsed.occurredAt,
    document: parsed.document,
  };
}

export interface RunTransformInput {
  configId: string;
  scope?: TransformScope | undefined;
}

// The replay pipeline — re-derives the corpus under `configId`'s knobs, without
// re-fetching source: every raw_capture row in scope (or the whole tenant,
// for an empty scope — a full backfill) is re-parsed and re-derived through
// deriveFromRawCapture (capture.ts) under a NEW generation (this run's own
// id), which never touches the 'live' generation's versions. Runs
// synchronously and never throws for a mid-run derivation failure — the run
// row itself is marked 'failed' with the error recorded, so a caller always
// gets a run summary back rather than an unhandled rejection.
export async function runTransform(
  deps: { db: Db; sql: RawSql; config: EngineConfig },
  input: RunTransformInput,
): Promise<TransformRunRow> {
  const configRow = await loadTransformConfig(deps.db, input.configId);
  const scope = input.scope ?? {};
  const runId = newId("trun");
  const generation = runId;

  await deps.db.insert(transformRun).values({
    id: runId,
    tenantId: configRow.tenantId,
    configId: configRow.id,
    scope,
    generation,
    status: "running",
    rawCount: 0,
    versionCount: 0,
    error: null,
    createdAt: new Date(),
    completedAt: null,
  });

  // Each row's re-derivation is isolated: one bad raw_capture row (an
  // unparseable payload, a transient embed failure, ...) must never discard
  // the durable progress already made on the rows before it. rawCount/
  // versionCount are accumulated as the loop goes and persisted with the
  // run's TRUE progress even when some rows fail — a run must never report
  // 0/0 when rows were actually derived. An error setting up the run itself
  // (e.g. the initial row select failing against a genuinely down DB) is
  // still caught by the outer try/catch below and reported with 0 progress,
  // which is accurate in that case since nothing was processed yet.
  let rawCount = 0;
  let versionCount = 0;
  let failedCount = 0;
  let firstError: string | null = null;
  let totalRows = 0;

  try {
    const rawRows = await selectRawCaptureRows(deps.db, configRow.tenantId, scope);
    totalRows = rawRows.length;
    const chunker = buildChunker(configRow.params.chunk);
    const embed = buildEmbedClientConfig(
      configRow.params.embed,
      deps.config.embed,
    );

    for (const row of rawRows) {
      try {
        const captureInput = parseRawCapturePayload(configRow.tenantId, row);
        const result = await deriveFromRawCapture(
          deps,
          captureInput,
          row.id,
          generation,
          { chunker, embed },
        );
        rawCount++;
        if (result.status === "captured") versionCount++;
      } catch (err) {
        failedCount++;
        const message = formatCaughtError(err);
        firstError ??= message;
        log.error(
          `transform run: one raw_capture row failed to re-derive: ${message}`,
          {
            runId,
            configId: configRow.id,
            tenantId: configRow.tenantId,
            rawCaptureId: row.id,
            error: message,
          },
        );
      }
    }
  } catch (err) {
    failedCount++;
    const message = formatCaughtError(err);
    firstError ??= message;
    log.error(
      `transform run failed before per-row derivation completed: ${message}`,
      {
        runId,
        configId: configRow.id,
        tenantId: configRow.tenantId,
        error: firstError,
      },
    );
  }

  const status = failedCount === 0 ? "completed" : "failed";
  const error =
    failedCount === 0
      ? null
      : `${failedCount}/${Math.max(totalRows, failedCount)} raw_capture row(s) failed to re-derive; first error: ${firstError}`;

  await deps.db
    .update(transformRun)
    .set({ status, rawCount, versionCount, error, completedAt: new Date() })
    .where(eq(transformRun.id, runId));

  return loadTransformRun(deps.db, runId);
}

export class TransformPromoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformPromoteError";
  }
}

/**
 * True when a transform_run may be promoted to live. Exported for unit tests.
 * Only completed runs are promotable — failed/running leave a partial corpus.
 */
export function isPromotableRunStatus(
  status: TransformRunRow["status"],
): status is "completed" {
  return status === "completed";
}

/**
 * Promote a completed staged generation to live.
 *
 * 1. Snapshot the current active embed model_key (for demote restore).
 * 2. Activate the run's embed model first so a failed activate leaves versions
 *    untouched (brief dense mismatch window is preferred over committed corpus
 *    with no matching dense table).
 * 3. Swap generations: live → archive tag, staged → live.
 * 4. Record archive tag + prior model_key + promoted_at for demote.
 *
 * Does not delete versions. Demote reverses the generation swap and re-activates
 * the prior live embed model when recorded.
 */
export async function promoteGeneration(
  deps: { db: Db; sql: RawSql; config: EngineConfig },
  input: { tenantId: string; generation: string },
): Promise<TransformRunRow> {
  if (input.generation === LIVE_GENERATION) {
    throw new TransformPromoteError("cannot promote the live generation onto itself");
  }

  const runRows = await deps.db
    .select()
    .from(transformRun)
    .where(
      and(
        eq(transformRun.generation, input.generation),
        eq(transformRun.tenantId, input.tenantId),
      ),
    )
    .limit(1);
  const run = runRows[0];
  if (!run) {
    throw new TransformPromoteError(
      `no transform_run for generation ${input.generation}`,
    );
  }
  if (run.promotedAt) {
    throw new TransformPromoteError(
      `generation ${input.generation} is already promoted`,
    );
  }
  if (!isPromotableRunStatus(run.status as TransformRunRow["status"])) {
    throw new TransformPromoteError(
      `generation ${input.generation} is not completed (status=${run.status})`,
    );
  }

  const configRow = await loadTransformConfig(deps.db, run.configId);
  if (configRow.tenantId !== input.tenantId) {
    throw new TransformPromoteError(
      `transform_config tenant mismatch for generation ${input.generation}`,
    );
  }
  const embed = buildEmbedClientConfig(configRow.params.embed, deps.config.embed);
  const archiveGen = `archive_${run.id}_${Date.now()}`;
  const readClient = createRawSqlClient(deps.sql);

  // Snapshot prior active model before we flip dense search.
  const priorActive = await resolveActiveEmbedTable(readClient, input.tenantId);
  const priorModelKey = priorActive?.modelKey ?? null;

  // Activate the staged embed model and swap generation tags inside one
  // Postgres transaction. resolveActiveEmbedTable and the live-generation
  // filter used by search are otherwise readable independently, which opens
  // a window where dense search resolves the newly-active (staged) table
  // while `version` rows are still tagged with the pre-swap generation —
  // a silent, empty-result degradation of live dense search. Doing both
  // writes in one transaction means any concurrent reader sees only the
  // fully-pre-promote or fully-post-promote state, never the half-way one.
  // A thrown error here rolls back the embed activation too, so no separate
  // restore-on-failure step is needed.
  await deps.sql.begin(async (txSql) => {
    const txClient = createRawSqlClient(txSql);
    await activateEmbedModel(txClient, input.tenantId, embed);

    // 1) archive current live
    await txSql.unsafe(
      `UPDATE "memory"."version" SET generation = $1 WHERE tenant_id = $2 AND generation = $3`,
      [archiveGen, input.tenantId, LIVE_GENERATION],
    );
    // 2) promote staged → live
    await txSql.unsafe(
      `UPDATE "memory"."version" SET generation = $1 WHERE tenant_id = $2 AND generation = $3`,
      [LIVE_GENERATION, input.tenantId, input.generation],
    );
    // 3) bookkeeping — generation column stays the original run id for lookup;
    //    versions now live under 'live'. Search by generation=runId after
    //    promote finds nothing (expected); demote restores.
    await txSql.unsafe(
      `UPDATE "memory"."transform_run" SET archived_live_generation = $1, archived_live_model_key = $2, promoted_at = now() WHERE id = $3`,
      [archiveGen, priorModelKey, run.id],
    );
  });

  return loadTransformRun(deps.db, run.id);
}

/**
 * Demote a previously promoted generation: swap archive back to live and
 * move the demoted live corpus back onto the run's generation tag. Restores
 * the pre-promote active embed model when one was recorded.
 */
export async function demoteGeneration(
  deps: { db: Db; sql: RawSql; config: EngineConfig },
  input: { tenantId: string; generation: string },
): Promise<TransformRunRow> {
  const runRows = await deps.db
    .select()
    .from(transformRun)
    .where(
      and(
        eq(transformRun.generation, input.generation),
        eq(transformRun.tenantId, input.tenantId),
      ),
    )
    .limit(1);
  const run = runRows[0];
  if (!run) {
    throw new TransformPromoteError(
      `no transform_run for generation ${input.generation}`,
    );
  }
  if (!run.promotedAt || !run.archivedLiveGeneration) {
    throw new TransformPromoteError(
      `generation ${input.generation} is not currently promoted`,
    );
  }

  const archiveGen = run.archivedLiveGeneration;
  const priorModelKey = run.archivedLiveModelKey ?? null;

  // Restore prior dense target and rewrite generation tags inside one
  // Postgres transaction — see promoteGeneration for why: doing these as
  // separate writes lets a concurrent reader observe the restored model
  // paired with not-yet-swapped generation tags (or vice versa), silently
  // emptying live dense search for the duration of the gap. A thrown error
  // here rolls back the restore too, so demote is all-or-nothing.
  await deps.sql.begin(async (txSql) => {
    const txClient = createRawSqlClient(txSql);
    if (priorModelKey) {
      try {
        await activateEmbedModelByKey(txClient, input.tenantId, priorModelKey);
      } catch (err) {
        throw new TransformPromoteError(
          `cannot demote: failed to restore prior embed model ${priorModelKey}: ${formatCaughtError(err)}`,
        );
      }
    } else {
      await clearActiveEmbedModels(txClient, input.tenantId);
    }

    // live (promoted) → back to run generation
    await txSql.unsafe(
      `UPDATE "memory"."version" SET generation = $1 WHERE tenant_id = $2 AND generation = $3`,
      [input.generation, input.tenantId, LIVE_GENERATION],
    );
    // archive → live
    await txSql.unsafe(
      `UPDATE "memory"."version" SET generation = $1 WHERE tenant_id = $2 AND generation = $3`,
      [LIVE_GENERATION, input.tenantId, archiveGen],
    );
    await txSql.unsafe(
      `UPDATE "memory"."transform_run" SET archived_live_generation = NULL, archived_live_model_key = NULL, promoted_at = NULL WHERE id = $1`,
      [run.id],
    );
  });

  return loadTransformRun(deps.db, run.id);
}
