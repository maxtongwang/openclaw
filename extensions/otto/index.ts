/**
 * Otto CRM Extension for OpenClaw
 *
 * Provides CRM tools, context injection, and pipeline services for the Otto
 * real-estate relationship platform. All Otto domain data lives in Supabase;
 * OpenClaw handles sessions, memory, and channel routing.
 *
 * Multi-tenancy: tools are registered via factory so each tool call receives
 * per-call OpenClawPluginToolContext. The tenant middleware resolves the correct
 * workspaceId from (messageChannel, agentAccountId) via tenant_channel_mappings,
 * falling back to the plugin-level workspaceId for single-tenant deployments.
 */

import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { createClient } from "@supabase/supabase-js";
import type { OttoExtClient } from "./lib/client.js";
import { buildSlashCommand } from "./commands/slash.js";
import { buildContextInjectionHook } from "./hooks/context-injection.js";
import { resolveWorkspaceId } from "./middleware/tenant.js";
import { buildPipelineService } from "./services/pipeline.js";
import { buildComposeTools } from "./tools/compose.js";
import { buildCrmTools } from "./tools/crm.js";
import { buildGmailTools } from "./tools/gmail.js";
import { buildSettingsTools } from "./tools/settings.js";
import { buildSourceTools } from "./tools/sources.js";
import { buildTaskTools } from "./tools/tasks.js";

type OttoConfig = {
  supabaseUrl: string;
  supabaseServiceKey: string;
  workspaceId: string;
};

function assertOttoConfig(config: unknown): OttoConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Otto: plugin config is missing");
  }
  const c = config as Record<string, unknown>;
  if (typeof c.supabaseUrl !== "string" || !c.supabaseUrl) {
    throw new Error("Otto: supabaseUrl is required");
  }
  if (typeof c.supabaseServiceKey !== "string" || !c.supabaseServiceKey) {
    throw new Error("Otto: supabaseServiceKey is required");
  }
  if (typeof c.workspaceId !== "string" || !c.workspaceId) {
    throw new Error("Otto: workspaceId is required");
  }
  return {
    supabaseUrl: c.supabaseUrl,
    supabaseServiceKey: c.supabaseServiceKey,
    workspaceId: c.workspaceId,
  };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = assertOttoConfig(api.pluginConfig);

  // Supabase client shared across all tenants (service key bypasses RLS;
  // workspace isolation is enforced via workspace_id column filters in each query).
  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // Static client for hooks and commands that don't have per-call context.
  const staticClient: OttoExtClient = {
    supabase,
    workspaceId: cfg.workspaceId,
  };

  api.logger.info(`Otto extension loaded (workspaceId=${cfg.workspaceId}, url=${cfg.supabaseUrl})`);

  // ── Register tools via factory for per-call tenant resolution ─────────────
  //
  // Each factory call receives OpenClawPluginToolContext with messageChannel
  // and agentAccountId. resolveWorkspaceId looks up tenant_channel_mappings
  // (cached after first DB hit) and falls back to cfg.workspaceId.
  //
  // Tool count: CRM(11) + Tasks(3) + Compose(4) + Gmail(3) + Settings(2) + Sources(2) = 25

  function registerToolGroup(
    ctx: OpenClawPluginToolContext,
    buildFn: (
      supabase: ReturnType<typeof createClient>,
      getWorkspaceId: () => Promise<string>,
    ) => unknown[],
  ) {
    const getWorkspaceId = () => resolveWorkspaceId(ctx, supabase, cfg.workspaceId);
    // oxlint-disable-next-line typescript/no-explicit-any
    return buildFn(supabase, getWorkspaceId) as any[];
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => registerToolGroup(ctx, buildCrmTools) as any,
  );
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => registerToolGroup(ctx, buildTaskTools) as any,
  );
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => registerToolGroup(ctx, buildComposeTools) as any,
  );
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => registerToolGroup(ctx, buildGmailTools) as any,
  );
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => registerToolGroup(ctx, buildSettingsTools) as any,
  );
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => registerToolGroup(ctx, buildSourceTools) as any,
  );

  api.logger.info("Otto: registered tools via factory (multi-tenant mode, ~25 tools)");

  // ── Register before_agent_start context injection ─────────────────────────
  // Note: before_agent_start doesn't expose per-call channel/account info,
  // so context injection uses the static default workspace. This is acceptable
  // since context injection is best-effort (non-fatal on failure).
  api.on("before_agent_start", buildContextInjectionHook(staticClient));

  // ── Register /otto slash command ─────────────────────────────────────────
  // Slash commands also lack per-call channel context; use static workspace.
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerCommand(buildSlashCommand(staticClient) as any);

  // ── Register pipeline service (Gmail poller + daily digest) ─────────────
  api.registerService(buildPipelineService(cfg.workspaceId));
}
