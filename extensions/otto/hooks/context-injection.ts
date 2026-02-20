/**
 * before_agent_start hook — injects relevant CRM entity context
 * into each agent turn based on the user's message.
 */

import type { OttoExtClient } from "../lib/client.js";

/** Format entity results as a concise markdown context block. */
function formatEntitiesAsContext(entities: Array<Record<string, unknown>>): string {
  const lines = entities.map((e) => {
    const meta = (e.metadata as Record<string, unknown>) ?? {};
    const details: string[] = [];
    if (typeof meta.email === "string") {
      details.push(`email: ${meta.email}`);
    }
    if (typeof meta.phone === "string") {
      details.push(`phone: ${meta.phone}`);
    }
    if (typeof meta.company === "string") {
      details.push(`company: ${meta.company}`);
    }
    if (typeof meta.status === "string") {
      details.push(`status: ${meta.status}`);
    }
    const detailStr = details.length ? ` (${details.join(", ")})` : "";
    const name = typeof e.name === "string" ? e.name : "";
    const typeName =
      typeof e.type_name === "string"
        ? e.type_name
        : typeof e.type_id === "string"
          ? e.type_id
          : "entity";
    const id = typeof e.id === "string" ? e.id : "";
    return `- **${name}** [${typeName}]${detailStr} — id: ${id}`;
  });
  return `<otto-crm-context>\n## Relevant CRM Entities\n${lines.join("\n")}\n</otto-crm-context>`;
}

/** Extract key nouns from the user message for FTS search */
function extractSearchTerms(prompt: string): string {
  // Strip common filler words and extract meaningful terms
  return prompt
    .replace(/[^\w\s@.-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= 3 &&
        ![
          "the",
          "and",
          "for",
          "with",
          "this",
          "that",
          "what",
          "how",
          "can",
          "you",
          "are",
          "was",
          "get",
          "set",
          "tell",
          "show",
          "find",
          "list",
          "give",
        ].includes(w.toLowerCase()),
    )
    .slice(0, 6)
    .join(" ");
}

export function buildContextInjectionHook(client: OttoExtClient) {
  return async (event: { prompt: string }) => {
    if (!event.prompt || event.prompt.length < 5) {
      return;
    }

    const searchTerms = extractSearchTerms(event.prompt);
    if (!searchTerms) {
      return;
    }

    try {
      const { data } = await client.supabase
        .rpc("search_entities", {
          p_workspace_id: client.workspaceId,
          p_query: searchTerms,
        })
        .limit(5);

      if (!data?.length) {
        return;
      }

      const entities = data as Array<Record<string, unknown>>;
      return {
        prependContext: formatEntitiesAsContext(entities),
      };
    } catch {
      // Non-fatal: context injection failure should not block the agent turn
      return;
    }
  };
}
