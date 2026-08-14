import { type } from "arktype";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db, RawSql } from "../db/client.ts";
import type { EngineConfig } from "../config.ts";
import { newId } from "../core/id.ts";
import { formatCaughtError, log } from "../log.ts";
import { rawCapture, transformConfig, transformRun } from "../db/schema.ts";
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
}

// Resolves a search-time `generation` (a transform_run id, per the 1:1
// `transform_run.generation` uniqueness) back to its config's tuning knobs.
// Returns `null` when the generation isn't a known replay run (including
// 'live', which the caller should never even ask this for) — hybridSearch
// falls back to its own engine defaults for every field in that case.
export async function resolveGenerationSearchParams(
  db: Db,
  generation: string,
): Promise<GenerationSearchParams | null> {
  const runRows = await db
    .select({ configId: transformRun.configId })
    .from(transformRun)
    .where(eq(transformRun.generation, generation))
    .limit(1);
  const run = runRows[0];
  if (!run) return null;

  const configRows = await db
    .select({ params: transformConfig.params })
    .from(transformConfig)
    .where(eq(transformConfig.id, run.configId))
    .limit(1);
  const configRow = configRows[0];
  if (!configRow) return null;

  const params = parseConfigParams(configRow.params);
  return {
    authorityWeight: params.authorityWeight,
    recencyHalfLifeDays: params.recencyHalfLifeDays,
    mmrLambda: params.mmrLambda,
    overfetch: params.overfetch,
    rerank: buildRerankClientConfig(params.rerank),
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
