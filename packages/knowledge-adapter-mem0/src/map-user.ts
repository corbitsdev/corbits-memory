/**
 * Map Corbits (tenantId, principalId) → Mem0 user_id.
 *
 * Length-prefixed encoding is injective for any free-form ids that do not
 * contain only digits-before-colon collisions: distinct pairs never share a
 * user_id even when ids contain `::` or `_`.
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
  // `${len}:${id}` twice — cannot collide across delimiter injection.
  return `${tenantId.length}:${tenantId}:${principalId.length}:${principalId}`;
}
