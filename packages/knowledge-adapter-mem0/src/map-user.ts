/**
 * Map Corbits (tenantId, principalId) → Mem0 user_id.
 *
 * Always `tenantId::principalId` so the same principal in different tenants
 * never shares a Mem0 user. Bare principal is forbidden.
 */
export function mapUser(tenantId: string, principalId: string): string {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error(
      "mapUser: tenantId is required and must be a non-empty string",
    );
  }
  if (typeof principalId !== "string" || principalId.trim() === "") {
    throw new Error(
      "mapUser: principalId is required and must be a non-empty string",
    );
  }
  return `${tenantId}::${principalId}`;
}
