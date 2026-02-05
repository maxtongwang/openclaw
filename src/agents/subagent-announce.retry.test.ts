import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(async () => "subagent output"),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: "main", scope: "per-sender" },
    }),
  };
});

const baseParams = {
  childSessionKey: "agent:main:subagent:test",
  childRunId: "run-retry",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "retry task",
  timeoutMs: 1000,
  cleanup: "keep" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" as const },
};

describe("subagent announce retry", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
  });

  it("retries announce on failure and succeeds on second attempt", async () => {
    let callCount = 0;
    callGatewayMock.mockImplementation(async (req: { method?: string }) => {
      if (req.method === "agent") {
        callCount++;
        if (callCount === 1) {
          throw new Error("network error");
        }
        return { runId: "run-main", status: "ok" };
      }
      return {};
    });

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    const didAnnounce = await runSubagentAnnounceFlow(baseParams);

    expect(didAnnounce).toBe(true);
    // First call fails, second succeeds
    const agentCalls = callGatewayMock.mock.calls.filter(
      (c) => (c[0] as { method?: string }).method === "agent",
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("sends fallback notification when all 3 announce attempts fail", async () => {
    let agentCallCount = 0;
    const agentCallMessages: string[] = [];
    callGatewayMock.mockImplementation(
      async (req: { method?: string; params?: { message?: string } }) => {
        if (req.method === "agent") {
          agentCallCount++;
          agentCallMessages.push(req.params?.message ?? "");
          // First 3 calls (announce attempts) fail, 4th call (fallback) succeeds
          if (agentCallCount <= 3) {
            throw new Error("network error");
          }
          return { runId: "run-main", status: "ok" };
        }
        return {};
      },
    );

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    const didAnnounce = await runSubagentAnnounceFlow(baseParams);

    expect(didAnnounce).toBe(true);
    // 3 announce attempts + 1 fallback notification = 4 agent calls
    expect(agentCallCount).toBe(4);
    // The fallback message should mention results could not be delivered
    expect(agentCallMessages[3]).toContain("could not be delivered");
  });

  it("returns false when all attempts and fallback fail", async () => {
    callGatewayMock.mockImplementation(async (req: { method?: string }) => {
      if (req.method === "agent") {
        throw new Error("network error");
      }
      return {};
    });

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    const didAnnounce = await runSubagentAnnounceFlow(baseParams);

    expect(didAnnounce).toBe(false);
  });

  it("truncates large subagent reply to prevent context overflow", async () => {
    // Create a reply that exceeds MAX_REPLY_CHARS (8000)
    const largeReply = "x".repeat(10000);
    const { readLatestAssistantReply } = await import("./tools/agent-step.js");
    vi.mocked(readLatestAssistantReply).mockResolvedValueOnce(largeReply);

    let capturedMessage = "";
    callGatewayMock.mockImplementation(
      async (req: { method?: string; params?: { message?: string } }) => {
        if (req.method === "agent") {
          capturedMessage = req.params?.message ?? "";
          return { runId: "run-main", status: "ok" };
        }
        return {};
      },
    );

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow(baseParams);

    // The message should contain the truncation marker
    expect(capturedMessage).toContain("[output truncated due to length]");
    // The message should be shorter than the original large reply
    expect(capturedMessage.length).toBeLessThan(largeReply.length);
  });
});
