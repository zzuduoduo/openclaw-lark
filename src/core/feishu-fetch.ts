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

import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
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

  // Get the actual URL string for protocol detection
  let urlString: string;
  if (typeof url === 'string') {
    urlString = url;
  } else if (url instanceof URL) {
    urlString = url.toString();
  } else if (url instanceof Request) {
    urlString = url.url;
  } else {
    urlString = String(url);
  }

  // Apply proxy agent if proxy URL is configured
  const proxyUrl = getProxyUrl();
  const fetchInit: RequestInit & { agent?: any } = { ...init, headers };

  if (proxyUrl) {
    try {
      const isHttps = urlString.startsWith('https://');
      fetchInit.agent = isHttps ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
    } catch (err) {
      // If proxy agent creation fails, log warning but continue without proxy
      console.warn(`[feishuFetch] Failed to create proxy agent: ${err}`);
    }
  }

  return fetch(url, fetchInit);
}
