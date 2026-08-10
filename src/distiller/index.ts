/**
 * Resident distiller — first-class DX for Corbits apps.
 *
 * Two ways to run:
 *
 * 1. **Workflow** (recommended on Interchange):
 *    `createResidentDistiller({ inference })` → deploy the workflow.
 *
 * 2. **Imperative tick** (any scheduler):
 *    `runDistillTick({ client, distill, after })` with your model in `distill`.
 *
 * Substrate (feed, claim-bearing add, attribution, retention) lives in the
 * memory plane; this module is the easy on-ramp, not a separate package.
 */
export {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_CRON_DEFAULT,
  RESIDENT_DISTILLER_WORKFLOW_ID,
} from "./constants.ts";

export {
  buildDistilledClaim,
  resolveNextCursor,
  shouldProcessFeedEntry,
  type BuildDistilledClaimArgs,
  type DistilledClaimWrite,
  type FeedEntryLike,
} from "./claim.ts";

export {
  runDistillTick,
  type DistillOutcome,
  type DistillTickFeedEntry,
  type DistillTickPage,
  type DistillTickResult,
  type RunDistillTickArgs,
} from "./tick.ts";

export {
  createResidentDistiller,
  type CreateResidentDistillerOpts,
  type ResidentDistiller,
} from "./workflow.ts";
