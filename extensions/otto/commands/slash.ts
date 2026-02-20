/**
 * /otto slash command — direct CRM operations bypassing the LLM.
 * Subcommands: find, add, status, task, watch, settings
 */

import type { OttoExtClient } from "../lib/client.js";

type CommandResult = { text: string };

export function buildSlashCommand(client: OttoExtClient) {
  const { supabase, workspaceId } = client;

  async function handleOttoCommand(args: string): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? "";
    const rest = parts.slice(1).join(" ");

    switch (sub) {
      case "find":
      case "search": {
        if (!rest) {
          return { text: "Usage: /otto find <query>" };
        }
        const { data, error } = await supabase
          .rpc("search_entities", {
            p_workspace_id: workspaceId,
            p_query: rest,
          })
          .limit(10);
        if (error) {
          return { text: `Error: ${error.message}` };
        }
        if (!data?.length) {
          return { text: `No entities found for "${rest}".` };
        }
        const lines = (data as Array<Record<string, unknown>>).map((e) => {
          const name = typeof e.name === "string" ? e.name : "";
          const typeName = typeof e.type_name === "string" ? e.type_name : "entity";
          const id = typeof e.id === "string" ? e.id : "";
          return `• **${name}** [${typeName}] — id: ${id}`;
        });
        return {
          text: `**Search results for "${rest}":**\n${lines.join("\n")}`,
        };
      }

      case "status": {
        const [entitiesRes, tasksRes, watchersRes] = await Promise.all([
          supabase
            .from("entities")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .is("archived_at", null),
          supabase
            .from("tasks")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("status", "pending"),
          supabase
            .from("watchers")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("enabled", true),
        ]);
        return {
          text:
            `**Otto Status**\n` +
            `• Entities: ${entitiesRes.count ?? "?"}\n` +
            `• Pending tasks: ${tasksRes.count ?? "?"}\n` +
            `• Active watchers: ${watchersRes.count ?? "?"}`,
        };
      }

      case "task": {
        if (!rest) {
          return { text: "Usage: /otto task <title>" };
        }
        const { data, error } = await supabase
          .from("tasks")
          .insert({
            workspace_id: workspaceId,
            title: rest,
            status: "pending",
            priority: "medium",
          })
          .select("id, title")
          .single();
        if (error) {
          return { text: `Error creating task: ${error.message}` };
        }
        return { text: `Task created: **${data.title}** (id: ${data.id})` };
      }

      case "watch": {
        const { data, error } = await supabase
          .from("watchers")
          .select("id, name, type, enabled")
          .eq("workspace_id", workspaceId)
          .order("name");
        if (error) {
          return { text: `Error: ${error.message}` };
        }
        if (!data?.length) {
          return { text: "No watchers configured." };
        }
        const lines = (data as Array<Record<string, unknown>>).map((w) => {
          const name = typeof w.name === "string" ? w.name : "";
          const type = typeof w.type === "string" ? w.type : "";
          const id = typeof w.id === "string" ? w.id : "";
          return `• ${w.enabled ? "✓" : "○"} **${name}** [${type}] — id: ${id}`;
        });
        return { text: `**Watchers:**\n${lines.join("\n")}` };
      }

      case "settings": {
        const { data, error } = await supabase
          .from("user_config")
          .select("autonomy_level, contact_rules, notification_preferences")
          .eq("workspace_id", workspaceId)
          .single();
        if (error || !data) {
          return { text: "No settings found — using defaults." };
        }
        return {
          text: (() => {
            const d = data as Record<string, unknown>;
            const autonomy = typeof d.autonomy_level === "string" ? d.autonomy_level : "propose";
            return (
              `**Otto Settings**\n` +
              `• Autonomy: ${autonomy}\n` +
              `• Contact rules: ${JSON.stringify(d.contact_rules ?? {})}\n` +
              `• Notifications: ${JSON.stringify(d.notification_preferences ?? {})}`
            );
          })(),
        };
      }

      case "help":
      default:
        return {
          text:
            "**Otto Commands:**\n" +
            "• `/otto find <query>` — search CRM entities\n" +
            "• `/otto status` — show CRM stats\n" +
            "• `/otto task <title>` — create a quick task\n" +
            "• `/otto watch` — list active watchers\n" +
            "• `/otto settings` — show workspace settings",
        };
    }
  }

  return {
    name: "otto",
    description: "Otto CRM direct commands (find, status, task, watch, settings)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string }) => {
      try {
        const result = await handleOttoCommand(ctx.args ?? "help");
        return { text: result.text };
      } catch (e) {
        return { text: `Otto error: ${String(e)}`, isError: true };
      }
    },
  };
}
