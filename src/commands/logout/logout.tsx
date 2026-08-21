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
import { clearCodexAuth } from '../../services/api/codex/credentials.js';
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';

export async function performLogout({ clearOnboarding = false }): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();

  await removeApiKey();
  await removeChatGPTAuth();
  await removeKimiAuth();
  clearChatGPTSettingsAuthMode();
  clearCodexSettingsAuth();

  // Wipe all secure storage data on logout
  const secureStorage = getSecureStorage();
  secureStorage.delete();

  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = { ...current };
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
}

function clearCodexSettingsAuth(): void {
  clearCodexAuth();
  clearCodexClientCache();
  delete process.env.CODEX_LOGIN_METHOD;
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.CODEX_REFRESH_TOKEN;
  delete process.env.CODEX_API_KEY;
  const userSettings = getSettingsForSource('userSettings') ?? {};
  const env = userSettings.env ?? {};
  if (
    env.CODEX_LOGIN_METHOD === undefined &&
    env.CODEX_ACCESS_TOKEN === undefined &&
    env.CODEX_REFRESH_TOKEN === undefined &&
    env.CODEX_API_KEY === undefined
  ) {
    return;
  }
  updateSettingsForSource('userSettings', {
    env: {
      CODEX_LOGIN_METHOD: undefined,
      CODEX_ACCESS_TOKEN: undefined,
      CODEX_REFRESH_TOKEN: undefined,
      CODEX_API_KEY: undefined,
    } as unknown as Record<string, string>,
  });
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
  updateSettingsForSource('userSettings', settingsUpdate);
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
