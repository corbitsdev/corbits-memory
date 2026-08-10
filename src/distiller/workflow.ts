/**
 * Ready-to-deploy resident distiller workflow for Interchange hosts.
 *
 * ```ts
 * import { createResidentDistiller } from "@corbits/memory/distiller";
 * import { memoryAdd, memoryFeed, memorySearch } from "@corbits/memory/tools";
 *
 * const workflow = createResidentDistiller({
 *   inference: { sources: [{ provider: "openai", model: "gpt-4.1-mini" }] },
 * });
 * // deploy with host workflow-deploy + env: memoryBaseUrl, memoryTenantId, memoryAuthToken
 * ```
 */
import {
  defineAgent,
  type AgentDefinition,
  type AnnotatedToolFactory,
  type BaseEnv,
  type InferencePreference,
} from "@intx/agent";
import { defineWorkflow, type WorkflowDefinition } from "@intx/workflow";

import { memoryAdd } from "../tools/add.ts";
import { memoryFeed } from "../tools/feed.ts";
import { memorySearch } from "../tools/search.ts";
import { MEMORY_CAPABILITY_IDS } from "../grant-requirements.ts";
import {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_CRON_DEFAULT,
  RESIDENT_DISTILLER_WORKFLOW_ID,
} from "./constants.ts";

const DEFAULT_SYSTEM_PROMPT = `You are the resident memory distiller for a Corbits tenant.

On each run:
1. Call memory_feed with after=<cursor from state or 0>, exclude_generator=${RESIDENT_DISTILLER_AGENT_ID}.
2. For each entry worth promoting to a durable claim:
   - Classify (event / deadline / state / lesson) and gate junk / action-only noise.
   - Write a concise claim via memory_add with:
     generator_agent_id=${RESIDENT_DISTILLER_AGENT_ID}
     provenance=inferred
     lineage_class=derived
     derived_from=[entry.versionId]
     access_tags=entry.accessTags (copy exactly — never add broader tags)
3. Fail soft on poison entries: skip them and still advance past the page.
4. Remember the page nextCursor for the next run (host state / your notes).

Never re-distill your own writes. Prefer few high-quality claims over many low-value ones.
When searching for corroboration, use memory_search and respect attribution (stated vs inferred).`;

export type CreateResidentDistillerOpts = {
  /** Workflow id (default resident-memory-distiller). */
  id?: string;
  /** Agent id / generatorAgentId (default resident-distiller). */
  agentId?: string;
  /** Cron schedule (default every 5 minutes). */
  cron?: string;
  /** Host inference preferences (required for deploy hashing). */
  inference: { sources: readonly InferencePreference[] };
  /** Override system prompt. */
  systemPrompt?: string;
  /**
   * Extra tool factories beyond memory_feed / memory_add / memory_search.
   * Default tools are always included first.
   */
  extraTools?: readonly AnnotatedToolFactory<BaseEnv>[];
  /** Optional agent description. */
  description?: string;
};

export type ResidentDistiller = {
  workflow: WorkflowDefinition;
  agent: AgentDefinition;
  generatorAgentId: string;
};

/**
 * Build a schedule-triggered workflow + agent preloaded with memory tools.
 * Host supplies inference sources and deploys with memory* env credentials.
 */
export function createResidentDistiller(
  opts: CreateResidentDistillerOpts,
): ResidentDistiller {
  const generatorAgentId = opts.agentId ?? RESIDENT_DISTILLER_AGENT_ID;
  const tools = [
    memoryFeed,
    memoryAdd,
    memorySearch,
    ...(opts.extraTools ?? []),
  ] as AnnotatedToolFactory<BaseEnv>[];

  const agent = defineAgent({
    id: generatorAgentId,
    description:
      opts.description ??
      "Resident memory distiller — feed → classify → claim write",
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    tools,
    capabilities: [...MEMORY_CAPABILITY_IDS],

    inference: opts.inference,
    tags: {
      role: "resident-distiller",
      package: "@corbits/memory",
    },
  });

  const workflow = defineWorkflow({
    id: opts.id ?? RESIDENT_DISTILLER_WORKFLOW_ID,
    trigger: {
      type: "schedule",
      cron: opts.cron ?? RESIDENT_DISTILLER_CRON_DEFAULT,
    },
    agent,
  });

  return { workflow, agent, generatorAgentId };
}
