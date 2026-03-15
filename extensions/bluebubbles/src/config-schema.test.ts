import { describe, expect, it } from "vitest";
import { BlueBubblesConfigSchema } from "./config-schema.js";

describe("BlueBubblesConfigSchema", () => {
  it("accepts account config when serverUrl and password are both set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: "secret", // pragma: allowlist secret
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts SecretRef password when serverUrl is set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: {
        source: "env",
        provider: "default",
        id: "BLUEBUBBLES_PASSWORD",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("requires password when top-level serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("requires password when account serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          serverUrl: "http://localhost:1234",
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["accounts", "work", "password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("allows password omission when serverUrl is not configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          name: "Work iMessage",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  // forcePrivateApi: headless macOS users enable this to avoid AppleScript fallback.
  it("accepts forcePrivateApi: true at top-level account", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: "secret", // pragma: allowlist secret
      forcePrivateApi: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts forcePrivateApi: true in named account", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        headless: {
          serverUrl: "http://localhost:1234",
          password: "secret", // pragma: allowlist secret
          forcePrivateApi: true,
        },
      },
    });
    expect(parsed.success).toBe(true);
  });
});
