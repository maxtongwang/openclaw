import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import { getBearerToken, resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";
import { injectTimestamp, timestampOptsFromConfig } from "./server-methods/agent-timestamp.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function buildAgentPrompt(messagesUnknown: unknown): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: Array<{
    role: "user" | "assistant" | "tool";
    entry: HistoryEntry;
  }> = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    if (!role || !content) {
      continue;
    }
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: content },
    });
  }

  let message = "";
  if (conversationEntries.length > 0) {
    let currentIndex = -1;
    for (let i = conversationEntries.length - 1; i >= 0; i -= 1) {
      const entryRole = conversationEntries[i]?.role;
      if (entryRole === "user" || entryRole === "tool") {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex < 0) {
      currentIndex = conversationEntries.length - 1;
    }
    const currentEntry = conversationEntries[currentIndex]?.entry;
    if (currentEntry) {
      const historyEntries = conversationEntries.slice(0, currentIndex).map((entry) => entry.entry);
      if (historyEntries.length === 0) {
        message = currentEntry.body;
      } else {
        const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
        message = buildHistoryContextFromEntries({
          entries: [...historyEntries, currentEntry],
          currentMessage: formatEntry(currentEntry),
          formatEntry,
        });
      }
    }
  }

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openai" });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/chat/completions") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? 1024 * 1024);
  if (body === undefined) {
    return true;
  }

  const payload = coerceRequest(body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const cfg = loadConfig();
  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenAiSessionKey({ req, agentId, user });
  const prompt = buildAgentPrompt(payload.messages);
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const stampedMessage = injectTimestamp(prompt.message, timestampOptsFromConfig(cfg));
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });

  // BodyForAgent carries the timestamp-stamped message plus any OpenAI system-role
  // messages prepended as context. Unlike chat.ts (which has no system-prompt concept),
  // the OpenAI spec uses system messages to configure behaviour, so we embed them here.
  // Body/CommandBody stay raw so command detection sees the unmodified slash command.
  const bodyForAgent = prompt.extraSystemPrompt
    ? `${prompt.extraSystemPrompt}\n\n${stampedMessage}`
    : stampedMessage;

  const ctx: MsgContext = {
    Body: prompt.message,
    BodyForAgent: bodyForAgent,
    BodyForCommands: prompt.message,
    RawBody: prompt.message,
    CommandBody: prompt.message,
    SessionKey: sessionKey,
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    ChatType: "direct",
    // Allow all slash commands — same as chat.send / webchat
    CommandAuthorized: true,
    MessageSid: runId,
  };

  if (!stream) {
    try {
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        ...prefixOptions,
        deliver: async (payload, info) => {
          if (info.kind !== "final") {
            return;
          }
          const text = payload.text?.trim() ?? "";
          if (text) {
            finalReplyParts.push(text);
          }
        },
      });

      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: { runId, onModelSelected },
      });
      await dispatcher.waitForIdle();

      const content = finalReplyParts.join("\n\n") || "No response from OpenClaw.";
      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: String(err), type: "api_error" },
      });
    }
    return true;
  }

  // --- Streaming path ---
  setSseHeaders(res);

  let wroteRole = false;
  let closed = false;
  // Set to true by onAgentRunStart when the LLM agent run begins.
  // False means a slash command was handled synchronously by the dispatcher.
  let agentRunStarted = false;
  const finalReplyParts: string[] = [];
  const abortController = new AbortController();

  const dispatcher = createReplyDispatcher({
    ...prefixOptions,
    deliver: async (payload, info) => {
      if (info.kind !== "final") {
        return;
      }
      const text = payload.text?.trim() ?? "";
      if (text) {
        finalReplyParts.push(text);
      }
    },
  });

  // Listen for incremental token events emitted by the agent run.
  // Only fires when agentRunStarted is true (i.e. a real LLM run, not a command).
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant" } }],
        });
      }

      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        // Emit the terminal chunk with finish_reason before [DONE] so strict
        // OpenAI-compatible clients (e.g. LangChain) can parse the stop reason.
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        });
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
    abortController.abort();
  });

  void dispatchInboundMessage({
    ctx,
    cfg,
    dispatcher,
    replyOptions: {
      runId,
      abortSignal: abortController.signal,
      // Disable block-level streaming so replies are delivered as complete blocks
      // to the dispatcher; token streaming comes from onAgentEvent above.
      disableBlockStreaming: true,
      onAgentRunStart: () => {
        agentRunStarted = true;
      },
      onModelSelected,
    },
  })
    .then(async () => {
      await dispatcher.waitForIdle();
      if (closed) {
        return;
      }

      if (!agentRunStarted) {
        // A slash command was handled — write its reply as a single SSE chunk.
        const content = finalReplyParts.join("\n\n");
        if (content) {
          if (!wroteRole) {
            wroteRole = true;
            writeSse(res, {
              id: runId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { role: "assistant" } }],
            });
          }
          writeSse(res, {
            id: runId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          });
          writeSse(res, {
            id: runId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
        }
      }
      // Defensive: if the agent run started but onAgentEvent lifecycle "end" never
      // fired (e.g. agent runner error that skips the lifecycle emit), close here.
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    })
    .catch((err) => {
      if (closed) {
        return;
      }
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: `Error: ${String(err)}` },
            finish_reason: "stop",
          },
        ],
      });
      closed = true;
      unsubscribe();
      writeDone(res);
      res.end();
    });

  return true;
}
