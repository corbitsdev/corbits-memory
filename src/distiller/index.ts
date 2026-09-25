/**
 * Resident distiller — first-class DX for Corbits apps.
 *
 * Two ways to run:
 *
 * 1. **Workflow** (recommended on Interchange):
 *    `createResidentDistiller({ mailTo, inference })` → deploy the
 *    workflow, then have the host mail `mailTo` on a schedule to tick it.
 *
 * 2. **Imperative tick** (any scheduler):
 *    `runDistillTick({ client, distill, after })` with your model in `distill`.
 *
 * Substrate (feed, claim-bearing add, attribution, retention) lives in the
 * memory plane; this module is the easy on-ramp, not a separate package.
 */
export {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_WORKFLOW_ID,
} from "./constants.js";

export {
  buildDistilledClaim,
  resolveNextCursor,
  shouldProcessFeedEntry,
  type BuildDistilledClaimArgs,
  type DistilledClaimWrite,
  type FeedEntryLike,
} from "./claim.js";

export {
  runDistillTick,
  type DistillOutcome,
  type DistillTickFeedEntry,
  type DistillTickPage,
  type DistillTickResult,
  type RunDistillTickArgs,
} from "./tick.js";

export {
  createResidentDistiller,
  type CreateResidentDistillerOpts,
  type ResidentDistiller,
} from "./workflow.js";
