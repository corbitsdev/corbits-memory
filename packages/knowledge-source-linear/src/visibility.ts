import type { LinearIssueData, VisibilitySpec } from "./types.ts";

/**
 * Collect principal ids known from the issue payload.
 * Only ids present on the webhook/GraphQL object — never invent team rosters.
 */
export function collectPrincipalIds(data: LinearIssueData): string[] {
  const ids = new Set<string>();
  if (data.creatorId) ids.add(data.creatorId);
  if (data.assigneeId) ids.add(data.assigneeId);
  if (data.creator?.id) ids.add(data.creator.id);
  if (data.assignee?.id) ids.add(data.assignee.id);
  for (const id of data.subscriberIds ?? []) {
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Private when the issue or its team is marked private.
 * Linear private teams must not expand to tenant-wide visibility.
 */
export function isPrivateIssue(data: LinearIssueData): boolean {
  if (data.private === true) return true;
  if (data.team?.private === true) return true;
  return false;
}

/**
 * True when the payload carries an explicit public/private signal.
 * Missing flags are treated as unknown (fail closed — never tenant).
 */
export function isPrivacyKnown(data: LinearIssueData): boolean {
  if (data.private === true || data.private === false) return true;
  if (data.team?.private === true || data.team?.private === false) return true;
  return false;
}

function privateOrPrincipals(principalIds: string[]): VisibilitySpec {
  if (principalIds.length <= 1) {
    const spec: VisibilitySpec = { mode: "private" };
    if (principalIds.length === 1) {
      spec.principalIds = principalIds;
    }
    return spec;
  }
  return { mode: "principals", principalIds };
}

/**
 * Map Linear issue visibility → KE VisibilitySpec.
 *
 * Rules:
 * 1. Private issues → `private` (one principal) or `principals` (creator /
 *    assignee / subscribers only). NEVER `tenant` (overshare guard).
 * 2. Explicit team-visible (`private: false` / `team.private: false`) →
 *    `tenant` (company-brain default). Never `source_acl`.
 * 3. Unknown privacy (flags omitted) → fail closed as private/principals.
 *    Partial webhook payloads must not become company-brain by default.
 */
export function mapIssueVisibility(data: LinearIssueData): VisibilitySpec {
  const principalIds = collectPrincipalIds(data);

  if (isPrivateIssue(data) || !isPrivacyKnown(data)) {
    return privateOrPrincipals(principalIds);
  }

  // Explicit non-private → team-visible company knowledge.
  return { mode: "tenant" };
}
