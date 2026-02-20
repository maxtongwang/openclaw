/**
 * Tenant resolver middleware for the Otto OpenClaw extension.
 *
 * Resolves the `workspaceId` for the current agent turn using the per-call
 * context provided by OpenClaw's tool factory mechanism.
 *
 * Resolution order:
 *   1. Look up (messageChannel, agentAccountId) in tenant_channel_mappings.
 *   2. Fall back to the plugin-level default workspaceId (single-tenant config).
 *
 * This allows a single gateway to serve multiple isolated tenants: each Discord
 * guild, Telegram chat, or Slack team maps to its own Otto workspace.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";

type TenantRow = { workspace_id: string };

// Cache resolved mappings in-process to avoid repeated DB lookups per tool call.
// Key: "<channel_type>:<account_id>", value: workspace_id.
const cache = new Map<string, string>();

/**
 * Resolve the workspaceId for the current tool-call context.
 *
 * @param ctx              Per-call context from OpenClawPluginToolFactory.
 * @param supabase         Supabase service-role client (bypasses RLS).
 * @param defaultWorkspace Fallback workspace from plugin config (single-tenant mode).
 * @returns               The resolved workspace ID.
 */
export async function resolveWorkspaceId(
  ctx: OpenClawPluginToolContext,
  supabase: SupabaseClient,
  defaultWorkspace: string,
): Promise<string> {
  const channel = ctx.messageChannel;
  const accountId = ctx.agentAccountId;

  // No per-call identity: fall back to plugin default
  if (!channel || !accountId) {
    return defaultWorkspace;
  }

  const cacheKey = `${channel}:${accountId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const { data, error } = await supabase
    .from("tenant_channel_mappings")
    .select("workspace_id")
    .eq("channel_type", channel)
    .eq("account_id", accountId)
    .maybeSingle<TenantRow>();

  if (!error && data?.workspace_id) {
    cache.set(cacheKey, data.workspace_id);
    return data.workspace_id;
  }

  // Not mapped: cache the fallback so subsequent calls skip the DB round-trip
  cache.set(cacheKey, defaultWorkspace);
  return defaultWorkspace;
}

/** Clear the in-process cache (useful in tests). */
export function clearTenantCache(): void {
  cache.clear();
}
