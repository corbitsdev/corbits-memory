/**
 * Knowledge plane backed by the engine's pgvector Postgres. Wraps the capture
 * and hybrid-search services directly — no HTTP hop.
 */
import type { EngineConfig } from "./config.ts";
import { formatCaughtError, log } from "./log.ts";
import { createDb, type Db, type RawSql } from "./db/client.ts";
import { createFtsVerification } from "./core/fts-language.ts";
import { createEmbedRegistrySqlClient } from "./core/embed-sql.ts";
import type { VisibilitySpec } from "./core/schemas/document.ts";
import { captureDocument } from "./services/capture.ts";
import {
  hybridSearch,
  KnowledgeSearchInputError,
  type HybridSearchResult,
} from "./services/search.ts";
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
  /** Principal ids blocked from seeing this doc (stored for search post-filter). */
  blockPrincipalIds?: string[];
  attributes?: Record<string, string | number | boolean | null>;
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
  close(): Promise<void>;
};

export function createKnowledgePlane(config: KnowledgeConfig): KnowledgePlane {
  const engineConfig: EngineConfig = config.knowledge;
  const { db, sql }: { db: Db; sql: RawSql } = createDb(engineConfig);
  const deps = { db, sql, config: engineConfig };

  // Serving-path schema validation, industry-standard fail-fast shape
  // (Hibernate validate / Rails check_all_pending!): the mount is
  // synchronous, so "before accepting traffic" becomes a memoized check
  // awaited by the first query. Read-only; migration stays a deploy step.
  // Hosts with a real readiness probe can call verifyFtsLanguage there
  // instead — this memo then resolves against an already-verified schema.
  const ensureVerified = createFtsVerification(
    createEmbedRegistrySqlClient(sql),
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

        // Block-list post-filter: docs may store acl_block as JSON array
        // of principal ids. Engine visibility does not model block lists yet.
        if (result.hits.length === 0) return result;
        const docIds = Array.from(
          new Set(result.hits.map((h) => h.document_id)),
        );
        const blocked = new Set<string>();
        const rows = await sql<
          { id: string; attributes: Record<string, unknown> | null }[]
        >`
          SELECT id, attributes
          FROM knowledge_document
          WHERE id = ANY(${docIds}::text[])
        `;
        for (const row of rows) {
          const raw = row.attributes?.["acl_block"];
          if (typeof raw !== "string" || raw.length === 0) continue;
          let list: unknown;
          try {
            list = JSON.parse(raw);
          } catch (err) {
            // Unparseable block list → fail closed: hide the doc rather than
            // risk surfacing something a corrupt ACL meant to block.
            const errMessage = formatCaughtError(err);
            log.warn(
              `search: unparseable acl_block, blocking document: ${errMessage}`,
              { documentId: row.id, error: errMessage },
            );
            blocked.add(row.id);
            continue;
          }
          if (Array.isArray(list) && list.includes(params.principalId)) {
            blocked.add(row.id);
          }
        }
        if (blocked.size === 0) return result;
        const hits = result.hits.filter((h) => !blocked.has(h.document_id));
        // result.evidence is already "none" only when there were no hits, so
        // a post-filter that empties the list is the only way to reach "none".
        return { ...result, hits, evidence: hits.length === 0 ? "none" : result.evidence };
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

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
