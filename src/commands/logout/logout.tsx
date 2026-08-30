import * as React from 'react';
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry is loaded lazily to avoid pulling in ~1.1MB of OpenTelemetry at startup
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { removeChatGPTAuth } from '../../services/api/openai/chatgptAuth.js';
import { removeKimiAuth } from '../../services/api/openai/kimiAuth.js';
import { clearCodexClientCache } from '../../services/api/codex/client.js';
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { withAuthMutationLock } from '../../utils/secureStorage/authLock.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';

export async function performLogout({ clearOnboarding = false }): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };

  // Flush telemetry BEFORE clearing credentials to prevent org data leakage.
  await attempt(async () => {
    const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
    await flushTelemetry();
  });

  await attempt(() => removeApiKey({ strict: true }));
  await attempt(removeChatGPTAuth);
  await attempt(removeKimiAuth);
  await attempt(clearChatGPTSettingsAuthMode);
  await attempt(clearCodexSettingsAuth);

  // This authoritative wipe must run even if a provider-specific cleanup failed.
  await attempt(() =>
    withAuthMutationLock(async () => {
      if (!getSecureStorage().delete()) {
        throw new Error('Failed to delete credentials from secure storage');
      }
    }),
  );

  await attempt(clearAuthRelatedCaches);
  await attempt(() => {
    const saved = saveGlobalConfig(current => {
      const updated = { ...current, primaryApiKey: undefined };
      if (clearOnboarding) {
        updated.hasCompletedOnboarding = false;
        updated.subscriptionNoticeCount = 0;
        updated.hasAvailableSubscription = false;
        if (updated.customApiKeyResponses?.approved) {
          updated.customApiKeyResponses = {
            ...updated.customApiKeyResponses,
            approved: [],
          };
        }
      }
      updated.oauthAccount = undefined;
      return updated;
    });
    if (!saved) throw new Error('Failed to clear global authentication config');
  });

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Logout did not clear all credentials');
  }
}

function clearCodexSettingsAuth(): void {
  clearCodexClientCache();
  delete process.env.CODEX_LOGIN_METHOD;
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.CODEX_REFRESH_TOKEN;
  delete process.env.CODEX_API_KEY;
  delete process.env.CODEX_ACCOUNT_ID;
  const userSettings = getSettingsForSource('userSettings') ?? {};
  const env = userSettings.env ?? {};
  if (
    env.CODEX_LOGIN_METHOD === undefined &&
    env.CODEX_ACCESS_TOKEN === undefined &&
    env.CODEX_REFRESH_TOKEN === undefined &&
    env.CODEX_API_KEY === undefined &&
    env.CODEX_ACCOUNT_ID === undefined
  ) {
    return;
  }
  const { error } = updateSettingsForSource('userSettings', {
    env: {
      CODEX_LOGIN_METHOD: undefined,
      CODEX_ACCESS_TOKEN: undefined,
      CODEX_REFRESH_TOKEN: undefined,
      CODEX_API_KEY: undefined,
      CODEX_ACCOUNT_ID: undefined,
    } as unknown as Record<string, string>,
  });
  if (error) throw error;
}

function clearChatGPTSettingsAuthMode(): void {
  delete process.env.OPENAI_AUTH_MODE;
  const userSettings = getSettingsForSource('userSettings') ?? {};
  const env = userSettings.env ?? {};
  const hasOpenAICompatibleConfig =
    Boolean(env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY) &&
    Boolean(env.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL);
  const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
    ...(userSettings.modelType === 'openai' && !hasOpenAICompatibleConfig ? { modelType: undefined } : {}),
    env: {
      OPENAI_AUTH_MODE: undefined,
    } as unknown as Record<string, string>,
  };
  const { error } = updateSettingsForSource('userSettings', settingsUpdate);
  if (error) throw error;
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  // Clear the OAuth token cache
  getClaudeAIOAuthTokens.cache?.clear?.();
  clearTrustedDeviceTokenCache();
  clearBetasCaches();
  clearToolSchemaCache();

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache();
  refreshGrowthBookAfterAuthChange();

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache();

  // Clear policy limits cache
  await clearPolicyLimitsCache();
}

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true });

  const message = <Text>Successfully logged out.</Text>;

  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);

  return message;
}
