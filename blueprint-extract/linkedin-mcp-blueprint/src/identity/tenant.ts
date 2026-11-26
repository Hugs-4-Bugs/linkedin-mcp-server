/**
 * Tenant/user identity context (blueprint `identity/` seam).
 *
 * M2 model: a *local principal* is the human or agent operating a connection.
 * `TenantContext` travels with every tool call (injected by the tool
 * registration layer, never trusted from tool arguments). Tenant isolation
 * (owner D-A8) hangs off this: storage keys always include tenantId, and the
 * authorization gate requires an explicit non-wildcard tenant.
 */
export interface TenantContext {
  tenantId: string;
  userId: string;
}

export const LOCAL_DEV_TENANT: TenantContext = {
  // Local dev: one implicit tenant. Multi-tenant identifiers arrive with the
  // hosted identity layer (M5+); this constant is the only sanctioned
  // wildcard-free default and is deliberately not configurable.
  tenantId: 'local-tenant',
  userId: 'local-user',
};

export function tenantKey(ctx: TenantContext): string {
  return `${ctx.tenantId}/${ctx.userId}`;
}
