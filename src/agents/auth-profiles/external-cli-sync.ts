import {
  readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
  readClaudeCliCredentialsCached,
} from "../cli-credentials.js";
import {
  EXTERNAL_CLI_NEAR_EXPIRY_MS,
  EXTERNAL_CLI_SYNC_TTL_MS,
  QWEN_CLI_PROFILE_ID,
  MINIMAX_CLI_PROFILE_ID,
  log,
} from "./constants.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalOAuthProvider = "qwen-portal" | "minimax-portal" | "anthropic";

type ExternalSyncTarget = {
  profileId: string;
  provider: ExternalOAuthProvider;
  readCredentials: () => OAuthCredential | null;
  logMessage?: string;
};

function shallowEqualOAuthCredentials(a: OAuthCredential | undefined, b: OAuthCredential): boolean {
  if (!a) {
    return false;
  }
  if (a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function isExternalOAuthProvider(provider: string): provider is ExternalOAuthProvider {
  return provider === "qwen-portal" || provider === "minimax-portal" || provider === "anthropic";
}

function isExternalProfileFresh(cred: AuthProfileCredential | undefined, now: number): boolean {
  if (!cred) {
    return false;
  }
  if (cred.type !== "oauth" && cred.type !== "token") {
    return false;
  }
  if (!isExternalOAuthProvider(cred.provider)) {
    return false;
  }
  if (typeof cred.expires !== "number") {
    return true;
  }
  return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}

/** Sync external CLI credentials into the store for a given provider. */
function syncExternalCliCredentialsForProvider(
  store: AuthProfileStore,
  profileId: string,
  provider: string,
  readCredentials: () => OAuthCredential | null,
  now: number,
  logMessage?: string,
): boolean {
  const existing = store.profiles[profileId];
  const shouldSync =
    !existing || existing.provider !== provider || !isExternalProfileFresh(existing, now);
  const creds = shouldSync ? readCredentials() : null;
  if (!creds) {
    return false;
  }

  const existingOAuth = existing?.type === "oauth" ? existing : undefined;
  const shouldUpdate =
    !existingOAuth ||
    existingOAuth.provider !== provider ||
    existingOAuth.expires <= now ||
    creds.expires > existingOAuth.expires;

  if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, creds)) {
    store.profiles[profileId] = creds;
    log.info(logMessage ?? `synced ${provider} credentials from external cli`, {
      profileId,
      expires: new Date(creds.expires).toISOString(),
    });
    return true;
  }

  return false;
}

/**
 * Sync OAuth credentials from external CLI tools into the store.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(store: AuthProfileStore): boolean {
  let mutated = false;
  const now = Date.now();

  const syncTargets: ExternalSyncTarget[] = [
    {
      profileId: QWEN_CLI_PROFILE_ID,
      provider: "qwen-portal",
      readCredentials: () => readQwenCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
      logMessage: "synced qwen credentials from qwen cli",
    },
    {
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
    },
  ];

  for (const target of syncTargets) {
    if (
      syncExternalCliCredentialsForProvider(
        store,
        target.profileId,
        target.provider,
        target.readCredentials,
        now,
        target.logMessage,
      )
    ) {
      mutated = true;
    }
  }

  // Sync from Claude Code CLI (Keychain on macOS, file fallback)
  const readClaudeCreds = () => {
    const cred = readClaudeCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS });
    // Only OAuth credentials (with refresh token) are useful for sync
    return cred?.type === "oauth" ? cred : null;
  };
  // Sync "anthropic:default" only when it is already oauth.
  // Never auto-convert api_key/token profiles to oauth.
  const ANTHROPIC_DEFAULT_ID = "anthropic:default";
  const existingDefault = store.profiles[ANTHROPIC_DEFAULT_ID];
  if (
    existingDefault &&
    existingDefault.provider === "anthropic" &&
    existingDefault.type === "oauth"
  ) {
    if (
      syncExternalCliCredentialsForProvider(
        store,
        ANTHROPIC_DEFAULT_ID,
        "anthropic",
        readClaudeCreds,
        now,
      )
    ) {
      mutated = true;
    }
  }

  return mutated;
}
