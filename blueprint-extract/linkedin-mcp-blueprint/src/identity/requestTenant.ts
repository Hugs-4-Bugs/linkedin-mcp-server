/**
 * Per-request tenant resolution (M5, ADR-019): AsyncLocalStorage carries the
 * AUTHENTICATED tenant from the HTTP middleware down to the tool context,
 * replacing the M1–M4 single LOCAL_DEV_TENANT for remote requests. stdio
 * keeps the fixed local tenant (no store installed = local dev tenant).
 *
 * A caller-supplied tenant id NEVER participates: the only writer of this
 * store is the auth middleware, after credential validation.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { LOCAL_DEV_TENANT, type TenantContext } from './tenant.js';

const requestTenantStorage = new AsyncLocalStorage<TenantContext>();

/** Run a request handler with the authenticated tenant installed. */
export function runWithTenant<R>(tenant: TenantContext, body: () => R): R {
  return requestTenantStorage.run(tenant, body);
}

/**
 * The tenant for the current async context: the authenticated tenant when
 * installed by the HTTP middleware, otherwise the local dev tenant (stdio).
 */
export function currentTenant(): TenantContext {
  return requestTenantStorage.getStore() ?? LOCAL_DEV_TENANT;
}
