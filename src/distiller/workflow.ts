/**
 * Ready-to-deploy resident distiller workflow for Interchange hosts.
 *
 * ```ts
 * import { createResidentDistiller } from "@corbits/memory/distiller";
 *
 * const workflow = createResidentDistiller({
 *   mailTo: "resident-distiller@tenant.example.com",
 *   inference: { sources: [{ provider: "openai", model: "gpt-4.1-mini" }] },
 * });
 * // deploy with host workflow-deploy; the host binds the `hub` credential
 * // handle the sidecar bundle resolves at run time, and ticks the workflow
 * // by mailing `mailTo` (e.g. a @corbits/cron schedule) — see the README.
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

import { memory } from "../sidecar-bundle.js";
import { capabilityIdsForSurface } from "../grant-requirements.js";
import {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_WORKFLOW_ID,
} from "./constants.js";

const DEFAULT_SYSTEM_PROMPT = (generatorAgentId: string) =>
  `You are the resident memory distiller for a Corbits tenant.

On each run:
1. Call memory_feed with after=<cursor from state or 0>, exclude_generator=${generatorAgentId}.
2. For each entry worth promoting to a durable claim:
   - Classify (event / deadline / state / lesson) and gate junk / action-only noise.
   - Write a concise claim via memory_add with:
     generator_agent_id=${generatorAgentId}
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
  /**
   * The mail address this workflow's run is triggered at — the first
   * inbound mail here fires the deployment's stable top-level run. The
   * host owns ticking: mail this address on whatever cadence it wants
   * (e.g. a `@corbits/cron` schedule), see the README.
   */
  mailTo: string;
  /** Host inference preferences (required for deploy hashing). */
  inference: { sources: readonly InferencePreference[] };
  /** Override system prompt. */
  systemPrompt?: string;
  /**
   * Extra tool factories beyond the memory sidecar bundle, which is always
   * included first.
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
 * Build a mail-triggered workflow + agent preloaded with memory tools. Host
 * supplies inference sources and `mailTo`, and deploys with memory* env
 * credentials. Ticking (deciding when to mail `mailTo`) is the host's job.
 */
export function createResidentDistiller(
  opts: CreateResidentDistillerOpts,
): ResidentDistiller {
  const generatorAgentId = opts.agentId ?? RESIDENT_DISTILLER_AGENT_ID;
  const tools = [
    memory,
    ...(opts.extraTools ?? []),
  ] as unknown as AnnotatedToolFactory<BaseEnv>[];

  const agent = defineAgent({
    id: generatorAgentId,
    description:
      opts.description ??
      "Resident memory distiller — feed → classify → claim write",
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT(generatorAgentId),
    tools,
    capabilities: capabilityIdsForSurface("distiller"),

    inference: opts.inference,
    tags: {
      role: "resident-distiller",
      package: "@corbits/memory",
    },
  });

  const workflow = defineWorkflow({
    id: opts.id ?? RESIDENT_DISTILLER_WORKFLOW_ID,
    trigger: {
      type: "mail",
      to: opts.mailTo,
    },
    agent,
  });

  return { workflow, agent, generatorAgentId };
}
