// Otto CRM plugin for OpenClaw.
// On startup, fetches Otto's MCP tools/list and registers each as a native pi-tool
// so every agent sees CRM tools without needing the mcporter bridge.
// All tools are open by default; set ownerOnlyTools in config to restrict specific tools.

import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { Type } from "@sinclair/typebox";

let rpcId = 1;

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

async function mcpPost<T>(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result?: T; error?: { code?: number; message?: string } }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<{
    result?: T;
    error?: { code?: number; message?: string };
  }>;
}

const plugin: OpenClawPluginDefinition = {
  id: "otto",
  name: "Otto CRM",
  description: "Loads Otto MCP tools as native OpenClaw pi-tools at startup",

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as {
      url?: string;
      token?: string;
      ownerOnlyTools?: string[];
    };

    // OpenClaw plugin SDK doesn't await async register(); wrap async work in a
    // fire-and-forget IIFE so register() returns synchronously while tools are
    // fetched and registered in the background before any agent call arrives.
    (async () => {
      const baseUrl = cfg.url?.trim();
      if (!baseUrl) {
        api.logger.warn("otto: plugin disabled — set plugins.otto.config.url in openclaw.json");
        return;
      }

      const token = cfg.token?.trim() ?? "";
      const mcpUrl = `${baseUrl.replace(/\/$/, "")}/mcp`;

      // All tools open by default — override with ownerOnlyTools in config if needed
      const ownerOnlyTools = new Set(cfg.ownerOnlyTools ?? []);

      // Fetch Otto's live tool list — fail gracefully so Otto downtime doesn't break startup
      let tools: McpTool[];
      try {
        const resp = await mcpPost<{ tools: McpTool[] }>(mcpUrl, token, "tools/list");
        if (resp.error) {
          api.logger.error(
            `otto: tools/list failed: ${resp.error.message ?? `code ${resp.error.code}`}`,
          );
          return;
        }
        tools = resp.result?.tools ?? [];
      } catch (err) {
        api.logger.warn(`otto: could not reach ${mcpUrl} — CRM tools unavailable: ${String(err)}`);
        return;
      }

      if (tools.length === 0) {
        api.logger.warn("otto: no tools returned from MCP server");
        return;
      }

      api.logger.info(`otto: registering ${tools.length} CRM tools from ${mcpUrl}`);

      for (const tool of tools) {
        const isOwnerOnly = ownerOnlyTools.has(tool.name);

        // Forward Otto's raw JSON Schema directly — no conversion needed
        const parameters = Type.Unsafe<Record<string, unknown>>(
          tool.inputSchema ?? { type: "object", properties: {} },
        );

        api.registerTool(
          {
            name: tool.name,
            label: tool.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            description: tool.description,
            parameters,
            ownerOnly: isOwnerOnly || undefined,
            async execute(_toolCallId, args) {
              const resp = await mcpPost<{
                content: Array<{ type: string; text: string }>;
              }>(mcpUrl, token, "tools/call", {
                name: tool.name,
                arguments: args as Record<string, unknown>,
              });
              if (resp.error) {
                throw new Error(
                  `otto ${tool.name}: ${resp.error.message ?? `code ${resp.error.code}`}`,
                );
              }
              return {
                content: resp.result?.content ?? [{ type: "text", text: "(no result)" }],
                details: { tool: tool.name },
              };
            },
          },
          { name: tool.name },
        );
      }
    })().catch((err) => api.logger.warn(`otto: registration error: ${String(err)}`));
  },
};

export default plugin;
