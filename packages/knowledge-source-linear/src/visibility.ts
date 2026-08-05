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
 * Map Linear issue visibility → KE VisibilitySpec.
 *
 * Rules:
 * 1. Private issues → `private` (one principal) or `principals` (creator /
 *    assignee / subscribers only). NEVER `tenant` (overshare guard).
 * 2. Team-visible → `tenant` (company-brain default). Never `source_acl`
 *    (no aspirational ACL level without a read path).
 */
export function mapIssueVisibility(data: LinearIssueData): VisibilitySpec {
  const principalIds = collectPrincipalIds(data);

  if (isPrivateIssue(data)) {
    if (principalIds.length <= 1) {
      const spec: VisibilitySpec = { mode: "private" };
      if (principalIds.length === 1) {
        spec.principalIds = principalIds;
      }
      return spec;
    }
    return { mode: "principals", principalIds };
  }

  // Team-visible company knowledge. Prefer tenant; never source_acl.
  return { mode: "tenant" };
}
