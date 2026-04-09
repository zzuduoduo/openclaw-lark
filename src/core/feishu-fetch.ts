/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Header-aware fetch for Feishu API calls with proxy support.
 *
 * Drop-in replacement for `fetch()` that automatically injects
 * the User-Agent header and supports HTTP/HTTPS proxies via
 * environment variables.
 */

import { ProxyAgent } from 'undici';
import { getUserAgent } from './version';

/**
 * Returns the proxy URL from environment variables, or undefined if not set.
 */
function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
}

/**
 * Drop-in replacement for `fetch()` that automatically injects
 * the User-Agent header and applies proxy settings from environment variables.
 *
 * Used by `device-flow.ts`, `oauth.ts` and `uat-client.ts` so that the custom
 * User-Agent and proxy settings are transparently applied without changing
 * every call-site's signature.
 */
export function feishuFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = {
    ...init?.headers,
    'User-Agent': getUserAgent(),
  };

  // Apply proxy agent if proxy URL is configured.
  // Node.js native fetch is undici-based; proxy support requires `dispatcher`,
  // not the `agent` option used by node-fetch/axios.
  const proxyUrl = getProxyUrl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchInit: any = { ...init, headers };

  if (proxyUrl) {
    try {
      // Node.js native fetch is undici-based; `dispatcher` (not `agent`) is the correct option.
      // Cast to any to avoid Dispatcher type collision between undici package and @types/node.
      fetchInit.dispatcher = new ProxyAgent(proxyUrl);
    } catch (err) {
      console.warn(`[feishuFetch] Failed to create proxy agent: ${err}`);
    }
  }

  return fetch(url, fetchInit);
}
