/**
 * Knowledge plane backed by the engine's pgvector Postgres. Wraps the capture
 * and hybrid-search services directly — no HTTP hop.
 */
import { blockedDocumentIds } from "./acl.ts";
import type { EngineConfig } from "./config.ts";
import { log } from "./log.ts";
import { createDb, type Db, type RawSql } from "./db/client.ts";
import { createFtsVerification, parseFtsLanguage } from "./core/fts-language.ts";
import { createRawSqlClient } from "./core/embed-sql.ts";
import type { VisibilitySpec } from "./core/schemas/document.ts";
import { captureDocument } from "./services/capture.ts";
import {
  hybridSearch,
  KnowledgeSearchInputError,
  type HybridSearchResult,
} from "./services/search.ts";
import {
  listTimelineEvents,
  type TimelineEvent,
} from "./services/timeline.ts";
import type { KnowledgeConfig } from "./mount-config.ts";

export type KnowledgeIdentity = {
  principalId: string;
  tenantId: string;
};

export type KnowledgeSearchParams = KnowledgeIdentity & {
  query: string;
  k?: number;
};

export type KnowledgeCaptureParams = KnowledgeIdentity & {
  title: string;
  text: string;
  kind?: string;
  adapter?: string;
  externalRef?: string;
  visibility?: VisibilitySpec;
  /** Principal ids blocked from seeing this doc (stored for read-path post-filter). */
  blockPrincipalIds?: string[];
  attributes?: Record<string, string | number | boolean | null>;
};

export type KnowledgeTimelineParams = KnowledgeIdentity & {
  limit?: number;
};

export class KnowledgeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export type KnowledgePlane = {
  search(params: KnowledgeSearchParams): Promise<HybridSearchResult>;
  capture(params: KnowledgeCaptureParams): Promise<void>;
  timeline(params: KnowledgeTimelineParams): Promise<TimelineEvent[]>;
  close(): Promise<void>;
};

export type { TimelineEvent };

export function createKnowledgePlane(config: KnowledgeConfig): KnowledgePlane {
  // Resolve once here so EngineConfig.ftsLanguage is concrete for every
  // service — loadKnowledgeConfig already runs parseFtsLanguage, but a
  // hand-built EngineConfig may still carry an empty/absent value; this is
  // the single defaulting site services rely on.
  const engineConfig: EngineConfig = {
    ...config.knowledge,
    ftsLanguage: parseFtsLanguage(config.knowledge.ftsLanguage),
  };
  const { db, sql }: { db: Db; sql: RawSql } = createDb(engineConfig);
  const deps = { db, sql, config: engineConfig };

  // Serving-path schema validation, industry-standard fail-fast shape
  // (Hibernate validate / Rails check_all_pending!): the mount is
  // synchronous, so "before accepting traffic" becomes a memoized check
  // awaited by the first query. Read-only; migration stays a deploy step.
  // NOTE this is a lazy check, not a boot-time one: nothing forces it to run
  // until the first real search()/capture() call, so a host that neither
  // runs runKnowledgeMigrations itself nor wires a readiness probe will not
  // learn about a language mismatch until that first call fails. A host
  // that wants a real boot-time guarantee MUST call the exported
  // verifyFtsLanguage from its own readiness probe — this memo then
  // resolves instantly against the already-verified schema.
  const ensureVerified = createFtsVerification(
    createRawSqlClient(sql),
    engineConfig.ftsLanguage,
  );

  return {
    async search(params) {
      try {
        await ensureVerified();
        const result = await hybridSearch(deps, {
          tenantId: params.tenantId,
          principalId: params.principalId,
          query: params.query,
          k: params.k,
        });

        // Block-list post-filter: docs may store acl_block as a list of
        // principal ids. Engine visibility does not model block lists yet.
        // Shared with timeline via readBlockList / blockedDocumentIds.
        if (result.hits.length === 0) return result;
        const docIds = Array.from(
          new Set(result.hits.map((h) => h.document_id)),
        );
        const rows = await sql<
          { id: string; attributes: Record<string, unknown> | null }[]
        >`
          SELECT id, attributes
          FROM knowledge_document
          WHERE id = ANY(${docIds}::text[])
        `;
        const { blocked, unreadable } = blockedDocumentIds(
          docIds,
          rows,
          params.principalId,
        );
        if (unreadable.length > 0) {
          // Cap the sample so a large withhold batch cannot flood logs; count
          // is always present so the full size is still auditable.
          const sampleLimit = 20;
          const documentIds = unreadable.slice(0, sampleLimit);
          const more =
            unreadable.length > sampleLimit
              ? ` (+${unreadable.length - sampleLimit} more)`
              : "";
          log.warn(
            `search: ${unreadable.length} document(s) had an unreadable acl_block or missing row; withholding: ${documentIds.join(", ")}${more}`,
            { count: unreadable.length, documentIds },
          );
        }
        if (blocked.size === 0) return result;
        const hits = result.hits.filter((h) => !blocked.has(h.document_id));
        // result.evidence is already "none" only when there were no hits, so
        // a post-filter that empties the list is the only way to reach "none".
        return {
          ...result,
          hits,
          evidence: hits.length === 0 ? "none" : result.evidence,
        };
      } catch (err) {
        if (err instanceof KnowledgeSearchInputError) {
          throw new KnowledgeError(400, err.message);
        }
        throw err;
      }
    },

    async capture(params) {
      await ensureVerified();
      const adapter = params.adapter ?? "mcp";
      const externalRef =
        params.externalRef ??
        `knowledge:${params.tenantId}:${crypto.randomUUID()}`;
      const visibility = params.visibility ?? { mode: "tenant" as const };
      const attributes: Record<string, string | number | boolean | null> = {
        ...(params.attributes ?? {}),
      };
      if (params.blockPrincipalIds && params.blockPrincipalIds.length > 0) {
        attributes["acl_block"] = JSON.stringify(
          params.blockPrincipalIds,
        );
      }

      await captureDocument(deps, {
        tenantId: params.tenantId,
        adapter,
        occurredAt: new Date().toISOString(),
        document: {
          kind: params.kind ?? "note",
          title: params.title,
          externalRef,
          visibility,
          entityHints: [],
          chunks: [{ ordinal: 0, text: params.text }],
          actor: { kind: "human", principalId: params.principalId },
          contentHash: "", // recomputed canonically in adapt-and-plan
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        },
      });
    },

    async timeline(params) {
      return listTimelineEvents({
        db,
        tenantId: params.tenantId,
        principalId: params.principalId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
