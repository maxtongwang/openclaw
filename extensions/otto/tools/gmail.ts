/**
 * Gmail tools — search emails, send, generate digest.
 * Requires Google OAuth tokens stored in Supabase (source_configs table).
 */

import { Type } from "@sinclair/typebox";
import type { OttoExtClient } from "../lib/client.js";
import { textResult, errorResult, toJson } from "../lib/client.js";

/** Fetch the stored Google OAuth access token for the workspace. */
async function getGmailToken(client: OttoExtClient): Promise<string | null> {
  const { data } = await client.supabase
    .from("source_configs")
    .select("config")
    .eq("workspace_id", client.workspaceId)
    .eq("source_type", "gmail")
    .single();
  return (data?.config as Record<string, unknown>)?.access_token as string | null;
}

export function buildGmailTools(client: OttoExtClient) {
  // ── gmail_search_emails ───────────────────────────────────────────────────
  const gmail_search_emails = {
    name: "gmail_search_emails",
    label: "Gmail: Search Emails",
    description:
      "Search Gmail using Gmail query syntax. Returns subject, sender, date, and snippet for matching messages.",
    parameters: Type.Object({
      query: Type.String({
        description: 'Gmail search query (e.g., "from:john@example.com is:unread")',
      }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = params.query as string;
      const maxResults = Math.min((params.maxResults as number | undefined) ?? 10, 50);
      try {
        const token = await getGmailToken(client);
        if (!token) {
          return errorResult("Gmail not connected. Configure Google OAuth via source_configs.");
        }

        // List messages matching query
        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?` +
            `q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!listRes.ok) {
          const body = await listRes.text();
          if (listRes.status === 401) {
            return errorResult("Gmail token expired. Re-authenticate via Google OAuth.");
          }
          return errorResult(`Gmail API error ${listRes.status}: ${body}`);
        }

        const listData = (await listRes.json()) as {
          messages?: Array<{ id: string; threadId: string }>;
        };
        if (!listData.messages?.length) {
          return textResult("No emails found matching that query.");
        }

        // Fetch metadata for each message in parallel (capped at maxResults)
        const messages = await Promise.all(
          listData.messages.slice(0, maxResults).map(async (m) => {
            const msgRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject,From,Date`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!msgRes.ok) {
              return { id: m.id, error: msgRes.status };
            }
            const msg = (await msgRes.json()) as {
              id: string;
              threadId: string;
              snippet: string;
              payload: { headers: Array<{ name: string; value: string }> };
            };
            const headers = Object.fromEntries(msg.payload.headers.map((h) => [h.name, h.value]));
            return {
              id: msg.id,
              threadId: msg.threadId,
              subject: headers.Subject ?? "(no subject)",
              from: headers.From ?? "",
              date: headers.Date ?? "",
              snippet: msg.snippet,
            };
          }),
        );

        return textResult(toJson(messages));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── gmail_send_email ──────────────────────────────────────────────────────
  const gmail_send_email = {
    name: "gmail_send_email",
    label: "Gmail: Send Email",
    description: "Send an email via Gmail on behalf of the workspace account.",
    parameters: Type.Object({
      to: Type.Array(Type.String(), {
        description: "Recipient email addresses",
      }),
      subject: Type.String({ description: "Email subject line" }),
      body: Type.String({
        description: "Email body text (plain text or HTML)",
      }),
      cc: Type.Optional(Type.Array(Type.String(), { description: "CC email addresses" })),
      replyToMessageId: Type.Optional(
        Type.String({ description: "Gmail message ID to reply to (thread)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const to = params.to as string[];
      const subject = params.subject as string;
      const body = params.body as string;
      const cc = (params.cc as string[]) ?? [];
      const replyToMessageId = params.replyToMessageId as string | undefined;

      // Validate emails
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const addr of [...to, ...cc]) {
        if (!emailRe.test(addr) || /[\r\n]/.test(addr)) {
          return errorResult(`Invalid email address: ${addr}`);
        }
      }

      try {
        const token = await getGmailToken(client);
        if (!token) {
          return errorResult("Gmail not connected. Configure Google OAuth via source_configs.");
        }

        // Build RFC 2822 message
        const headers = [
          `To: ${to.join(", ")}`,
          ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
          `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
          "Content-Type: text/plain; charset=utf-8",
        ].join("\r\n");

        const rawMessage = `${headers}\r\n\r\n${body}`;
        const encoded = Buffer.from(rawMessage).toString("base64url");

        const sendBody: Record<string, unknown> = { raw: encoded };
        if (replyToMessageId) {
          // Get thread ID for reply threading
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${replyToMessageId}?format=minimal`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (msgRes.ok) {
            const msg = (await msgRes.json()) as { threadId: string };
            sendBody.threadId = msg.threadId;
          }
        }

        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(sendBody),
        });

        if (!res.ok) {
          const errBody = await res.text();
          if (res.status === 401) {
            return errorResult("Gmail token expired. Re-authenticate via Google OAuth.");
          }
          return errorResult(`Gmail send error ${res.status}: ${errBody}`);
        }

        const result = (await res.json()) as { id: string; threadId: string };
        return textResult(
          `Email sent successfully.\nMessage ID: ${result.id}\nThread: ${result.threadId}`,
        );
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── digest_generate ───────────────────────────────────────────────────────
  const digest_generate = {
    name: "digest_generate",
    label: "Digest: Generate",
    description:
      "Generate the daily digest — a summary of recent emails, tasks, and CRM activity. Returns the digest text.",
    parameters: Type.Object({
      date: Type.Optional(
        Type.String({
          description: "Date for digest in ISO format (default: today)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const date = (params.date as string) ?? new Date().toISOString().split("T")[0];
      if (isNaN(Date.parse(`${date}T00:00:00Z`))) {
        return errorResult(`Invalid date: "${date}". Use ISO format YYYY-MM-DD.`);
      }
      const cutoff = new Date(`${date}T00:00:00Z`).toISOString();

      try {
        const [tasksRes, notifRes] = await Promise.all([
          client.supabase
            .from("tasks")
            .select("title, due_at, priority, status")
            .eq("workspace_id", client.workspaceId)
            .eq("status", "pending")
            .order("due_at", { ascending: true })
            .limit(10),
          client.supabase
            .from("notifications")
            .select("source, title, body, created_at")
            .eq("workspace_id", client.workspaceId)
            .gte("created_at", cutoff)
            .order("created_at", { ascending: false })
            .limit(20),
        ]);

        const tasks = tasksRes.data ?? [];
        const notifs = notifRes.data ?? [];

        const parts: string[] = [`# Daily Digest — ${date}\n`];

        if (tasks.length) {
          parts.push(
            `## Pending Tasks (${tasks.length})\n` +
              tasks
                .map(
                  (t) =>
                    `- [${t.priority ?? "medium"}] ${t.title}${t.due_at ? ` (due ${t.due_at.split("T")[0]})` : ""}`,
                )
                .join("\n"),
          );
        }

        if (notifs.length) {
          parts.push(
            `\n## Recent Activity (${notifs.length} events)\n` +
              notifs
                .slice(0, 10)
                .map((n) => `- [${n.source}] ${n.title}`)
                .join("\n"),
          );
        }

        if (!tasks.length && !notifs.length) {
          parts.push("No tasks or activity found for this date.");
        }

        return textResult(parts.join("\n"));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  return [gmail_search_emails, gmail_send_email, digest_generate];
}
