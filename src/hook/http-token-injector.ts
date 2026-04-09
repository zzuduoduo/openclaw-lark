/**
 * HTTP Token Injector Hook
 *
 * Intercepts http_get / http_post tool calls and injects an Authorization
 * header by:
 *
 * 1. Reading the sender's user info (email, name) from the shared
 *    getUserInfoCache() — populated by resolveSenderInfo() at message-receive
 *    time, so no extra API call is needed here.
 * 2. Exchanging the user identity for a short-lived token via a configurable
 *    validateUser service.
 * 3. Injecting Authorization / X-User-* headers into the tool params.
 *
 * Configuration (from api.pluginConfig, set in orange config.yaml under
 * plugins.entries.openclaw-lark.config):
 *   http_token_injector.token_service_url  — POST { username, publicKey } → { valid, token }
 *   http_token_injector.public_key         — public key for validateUser
 *   http_token_injector.token_ttl_ms       — token cache TTL (default 5 min)
 *   http_token_injector.user_cache_ttl_ms  — user info max age (default 30 min)
 *   http_token_injector.target_url_prefix  — only inject for URLs with this prefix
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getUserInfoCache } from '../messaging/inbound/user-name-cache';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('http-token-injector');

/** token cache: openId → { token, expiresAt } */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function registerHttpTokenInjector(api: OpenClawPluginApi): void {
  const apiLog = api.logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = ((api.pluginConfig as any)?.http_token_injector ?? {}) as Record<string, unknown>;

  const TOKEN_SERVICE_URL = (cfg.token_service_url as string) ?? '';
  const PUBLIC_KEY = (cfg.public_key as string) ?? '';
  const TOKEN_TTL_MS = (cfg.token_ttl_ms as number) ?? 5 * 60 * 1000;
  const USER_CACHE_TTL_MS = (cfg.user_cache_ttl_ms as number) ?? 30 * 60 * 1000;
  const TARGET_URL_PREFIX = (cfg.target_url_prefix as string) ?? 'http://';

  if (!TOKEN_SERVICE_URL) {
    log.warn('token_service_url not configured — http token injection disabled');
    return;
  }
  if (!PUBLIC_KEY) {
    log.warn('public_key not configured — http token injection disabled');
    return;
  }

  log.info(`token service: ${TOKEN_SERVICE_URL} (TTL: ${TOKEN_TTL_MS}ms)`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hookHandler = async (payload: any): Promise<any> => {
    // payload is ToolCallPayload from orange shim
    const p = payload;
    const toolName: string = p.tool_name ?? '';
    const url: string = p.params?.url ?? '';
    const userId: string = p.user_id ?? '';
    const openId = userId.replace(/^feishu:/, '');
    apiLog.info(`[http-token-injector] hook triggered: tool=${toolName} user=${openId} url=${url}`);
    if (!openId) {
      return { action: 'continue' };
    }

    // Read user info from shared cache (written by resolveSenderInfo)
    const userInfo = getUserInfoCache().get(openId);
    apiLog.info(`[http-token-injector] user info for ${openId}: ${userInfo ? `name=${userInfo.name} email=${userInfo.email}` : 'not found in cache'}`);
    if (!userInfo) {
      log.debug(`no cached user info for ${openId}, skipping token injection`);
      return { action: 'continue' };
    }

    if (toolName !== 'http_get' && toolName !== 'http_post') {
      return { action: 'continue' };
    }

    if (TARGET_URL_PREFIX && !url.startsWith(TARGET_URL_PREFIX)) {
      return { action: 'continue' };
    }

    // Strip "feishu:" prefix to get bare openId


    if (Date.now() - userInfo.fetchedAt > USER_CACHE_TTL_MS) {
      getUserInfoCache().delete(openId);
      log.debug(`user cache expired for ${openId}`);
      return { action: 'continue' };
    }

    if (!userInfo.email || !userInfo.name) {
      log.debug(`incomplete user info for ${openId} (email=${userInfo.email}), skipping`);
      return { action: 'continue' };
    }

    // Get token from local cache or fetch from validateUser service
    let token: string;
    const cachedToken = tokenCache.get(openId);
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
      token = cachedToken.token;
    } else {
      try {
        log.info(`fetching token for ${openId} (name=${userInfo.name})`);
        const res = await fetch(TOKEN_SERVICE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: userInfo.name, publicKey: PUBLIC_KEY }),
        });

        if (!res.ok) {
          log.warn(`validateUser returned ${res.status} for ${openId}`);
          return { action: 'continue' };
        }

        const data = await res.json() as Record<string, unknown>;
        if (!data.valid) {
          log.warn(`validateUser failed for ${openId}: ${data.message ?? '校验失败'}`);
          return { action: 'continue' };
        }

        token = data.token as string;
        if (!token) {
          log.warn(`validateUser returned no token for ${openId}`);
          return { action: 'continue' };
        }

        tokenCache.set(openId, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
        log.info(`token cached for ${openId} (email: ${userInfo.email})`);
      } catch (err) {
        log.warn(`validateUser request failed: ${err instanceof Error ? err.message : String(err)}`);
        return { action: 'continue' };
      }
    }

    // Don't overwrite an existing Authorization header
    const existingHeaders = (p.params?.headers ?? {}) as Record<string, string>;
    if (existingHeaders['Authorization'] || existingHeaders['authorization']) {
      log.debug('Authorization already set, skipping injection');
      return { action: 'continue' };
    }

    const modifiedPayload = {
      ...p,
      params: {
        ...p.params,
        headers: {
          ...existingHeaders,
          Authorization: `Bearer ${token}`,
          'X-User-Email': userInfo.email,
          'X-User-Name': userInfo.name,
          'X-User-Id': openId,
        },
      },
    };

    log.info(`injected token for ${openId} → ${url}`);
    return { action: 'modify', payload: modifiedPayload };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.registerHook('before_tool_call', hookHandler as any, { name: 'http-token-injector', priority: 80 } as any);
}
