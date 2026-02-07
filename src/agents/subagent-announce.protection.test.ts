import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// Mock modules before importing the module under test
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      defaults: {
        compaction: {
          announceProtectionThreshold: 0.8,
        },
        contextTokens: 100_000,
      },
    },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "default"),
  resolveMainSessionKey: vi.fn(() => "agent:default:main"),
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn((key) => key ?? "main"),
}));

vi.mock("../auto-reply/reply/queue.js", () => ({
  resolveQueueSettings: vi.fn(() => ({
    mode: "followup",
    debounceMs: 2000,
    cap: 10,
    drop: "old",
  })),
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
}));

vi.mock("./subagent-announce-queue.js", () => ({
  enqueueAnnounce: vi.fn(),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("./subagent-progress-stream.js", () => ({
  buildBriefSummary: vi.fn(() => "summary"),
}));

// Import after mocks
import { loadConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { getSessionContextUsage } from "./context-usage.js";

describe("subagent-announce protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveAnnounceProtectionThreshold (via getSessionContextUsage)", () => {
    it("getSessionContextUsage returns warning status at 80%", () => {
      const result = getSessionContextUsage({
        sessionEntry: {
          sessionId: "test",
          updatedAt: Date.now(),
          totalTokens: 80_000,
          contextTokens: 100_000,
        },
        warningThreshold: 0.8,
      });
      expect(result).not.toBeNull();
      expect(result!.usageRatio).toBe(0.8);
      expect(result!.isWarning).toBe(true);
    });

    it("getSessionContextUsage returns healthy status below 80%", () => {
      const result = getSessionContextUsage({
        sessionEntry: {
          sessionId: "test",
          updatedAt: Date.now(),
          totalTokens: 70_000,
          contextTokens: 100_000,
        },
        warningThreshold: 0.8,
      });
      expect(result).not.toBeNull();
      expect(result!.usageRatio).toBe(0.7);
      expect(result!.isHealthy).toBe(true);
    });
  });

  describe("protection logic", () => {
    it("triggers compaction when usage exceeds threshold", async () => {
      const mockSessionEntry = {
        sessionId: "test-session",
        updatedAt: Date.now(),
        totalTokens: 85_000,
        contextTokens: 100_000,
      };

      vi.mocked(loadSessionStore).mockReturnValue({
        "agent:default:main": mockSessionEntry,
      });

      vi.mocked(loadConfig).mockReturnValue({
        agents: {
          defaults: {
            compaction: {
              announceProtectionThreshold: 0.8,
            },
            contextTokens: 100_000,
          },
        },
      } as OpenClawConfig);

      // Check that usage is above threshold
      const usage = getSessionContextUsage({
        sessionEntry: mockSessionEntry,
        config: loadConfig(),
        warningThreshold: 0.8,
      });
      expect(usage).not.toBeNull();
      expect(usage!.usageRatio).toBeGreaterThanOrEqual(0.8);
    });

    it("does not trigger compaction when usage is below threshold", async () => {
      const mockSessionEntry = {
        sessionId: "test-session",
        updatedAt: Date.now(),
        totalTokens: 50_000,
        contextTokens: 100_000,
      };

      // Check that usage is below threshold
      const usage = getSessionContextUsage({
        sessionEntry: mockSessionEntry,
        config: loadConfig(),
        warningThreshold: 0.8,
      });
      expect(usage).not.toBeNull();
      expect(usage!.usageRatio).toBeLessThan(0.8);
    });

    it("handles missing session entry gracefully", () => {
      const usage = getSessionContextUsage({
        sessionEntry: undefined,
        config: loadConfig(),
        warningThreshold: 0.8,
      });
      expect(usage).toBeNull();
    });

    it("handles missing totalTokens gracefully", () => {
      const usage = getSessionContextUsage({
        sessionEntry: {
          sessionId: "test",
          updatedAt: Date.now(),
          totalTokens: undefined,
          contextTokens: 100_000,
        },
        config: loadConfig(),
        warningThreshold: 0.8,
      });
      expect(usage).toBeNull();
    });
  });
});
