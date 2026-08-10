/**
 * Imperative distill tick — for hosts that want a function, not a workflow.
 * Inference stays injected: host supplies `distill` (call your model).
 */
import type { MemoryHttpClient } from "../tools/client.ts";
import {
  buildDistilledClaim,
  shouldProcessFeedEntry,
  type DistilledClaimWrite,
} from "./claim.ts";
import { RESIDENT_DISTILLER_AGENT_ID } from "./constants.ts";

export type DistillTickFeedEntry = {
  feedSeq: number;
  versionId: string;
  documentId: string;
  kind: string;
  title: string;
  status: string;
  createdByKind: string;
  generatorAgentId: string | null;
  provenance: string;
  occurredAt: string;
  createdAt: string;
  accessTags: string[];
};

export type DistillTickPage = {
  entries: DistillTickFeedEntry[];
  nextCursor: number | null;
};

export type DistillOutcome =
  | { action: "skip" }
  | { action: "poison"; reason?: string }
  | {
      action: "write";
      title: string;
      text: string;
      kind?: string;
      temporalClass?: "event" | "deadline" | "state" | "lesson";
    };

export type RunDistillTickArgs = {
  client: MemoryHttpClient;
  /** Exclusive cursor (last processed feed_seq). Default 0. */
  after?: number;
  limit?: number;
  generatorAgentId?: string;
  /**
   * Host inference: classify + distill one feed entry.
   * Return skip / poison / write. Never throw for poison — use { action: "poison" }.
   */
  distill: (entry: DistillTickFeedEntry) => Promise<DistillOutcome>;
  signal?: AbortSignal;
};

export type DistillTickResult = {
  /** Cursor to persist for the next tick. */
  nextCursor: number;
  processed: number;
  wrote: number;
  skipped: number;
  poisoned: number;
  claims: DistilledClaimWrite[];
};

function parseFeedPage(raw: unknown): DistillTickPage {
  if (raw === null || typeof raw !== "object") {
    throw new Error("distill tick: feed response is not an object");
  }
  const o = raw as Record<string, unknown>;
  const entriesRaw = o["entries"];
  if (!Array.isArray(entriesRaw)) {
    throw new Error("distill tick: feed.entries missing");
  }
  const entries: DistillTickFeedEntry[] = entriesRaw.map((e, i) => {
    if (e === null || typeof e !== "object") {
      throw new Error(`distill tick: feed.entries[${i}] invalid`);
    }
    const row = e as Record<string, unknown>;
    return {
      feedSeq: Number(row["feedSeq"]),
      versionId: String(row["versionId"] ?? ""),
      documentId: String(row["documentId"] ?? ""),
      kind: String(row["kind"] ?? "note"),
      title: String(row["title"] ?? ""),
      status: String(row["status"] ?? "active"),
      createdByKind: String(row["createdByKind"] ?? "system"),
      generatorAgentId:
        row["generatorAgentId"] === null || row["generatorAgentId"] === undefined
          ? null
          : String(row["generatorAgentId"]),
      provenance: String(row["provenance"] ?? "unknown"),
      occurredAt: String(row["occurredAt"] ?? ""),
      createdAt: String(row["createdAt"] ?? ""),
      accessTags: Array.isArray(row["accessTags"])
        ? (row["accessTags"] as unknown[]).map(String)
        : [],
    };
  });
  const next =
    o["nextCursor"] === null || o["nextCursor"] === undefined
      ? null
      : Number(o["nextCursor"]);
  return { entries, nextCursor: next };
}

/**
 * One distill tick: pull feed → host distill → write claims → return new cursor.
 * Persist `nextCursor` after the tick succeeds (including poison advances).
 */
export async function runDistillTick(
  args: RunDistillTickArgs,
): Promise<DistillTickResult> {
  const generatorAgentId =
    args.generatorAgentId ?? RESIDENT_DISTILLER_AGENT_ID;
  const after = args.after ?? 0;

  const raw = await args.client.feed(
    {
      after,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      excludeGenerator: generatorAgentId,
    },
    args.signal,
  );
  const page = parseFeedPage(raw);

  let wrote = 0;
  let skipped = 0;
  let poisoned = 0;
  const claims: DistilledClaimWrite[] = [];

  for (const entry of page.entries) {
    if (!shouldProcessFeedEntry(entry, generatorAgentId)) {
      skipped += 1;
      continue;
    }
    let outcome: DistillOutcome;
    try {
      outcome = await args.distill(entry);
    } catch (err) {
      // Fail-soft: treat unexpected throw as poison so the cursor still advances.
      poisoned += 1;
      void err;
      continue;
    }
    if (outcome.action === "skip") {
      skipped += 1;
      continue;
    }
    if (outcome.action === "poison") {
      poisoned += 1;
      continue;
    }

    const claim = buildDistilledClaim({
      title: outcome.title,
      text: outcome.text,
      sourceAccessTags: entry.accessTags,
      derivedFromVersionIds: [entry.versionId],
      generatorAgentId,
      ...(outcome.kind !== undefined ? { kind: outcome.kind } : {}),
      ...(outcome.temporalClass !== undefined
        ? { temporalClass: outcome.temporalClass }
        : {}),
    });
    await args.client.add(claim, args.signal);
    claims.push(claim);
    wrote += 1;
  }

  const nextCursor =
    page.nextCursor !== null && page.nextCursor !== undefined
      ? page.nextCursor
      : after;

  return {
    nextCursor,
    processed: page.entries.length,
    wrote,
    skipped,
    poisoned,
    claims,
  };
}
