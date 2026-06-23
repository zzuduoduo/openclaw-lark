/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-level chat task queue.
 *
 * Although located in channel/, this module is intentionally shared
 * across channel, messaging, tools, and card layers as a process-level
 * singleton. Consumers: monitor.ts, dispatch.ts, oauth.ts, auto-auth.ts.
 *
 * Ensures tasks targeting the same account+chat are executed serially.
 * Used by both websocket inbound messages and synthetic message paths.
 *
 * Each task is guarded by a per-task timeout.  If the task does not
 * settle within DEFAULT_TASK_TIMEOUT_MS, the chain proceeds so a
 * single stuck dispatch (e.g. a hung LLM call) cannot block all
 * subsequent messages for the chat forever.
 */

type QueueStatus = 'queued' | 'immediate';

/** Per-task deadline — after this the queue proceeds even if the task
 *  hasn't resolved.  10 minutes gives typical LLM + tool-call chains
 *  enough headroom while preventing a permanent queue deadlock. */
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface ActiveDispatcherEntry {
  abortCard: () => Promise<void>;
  abortController?: AbortController;
}

const chatQueues = new Map<string, Promise<void>>();
const activeDispatchers = new Map<string, ActiveDispatcherEntry>();

/**
 * Append `:thread:{threadId}` suffix when threadId is present.
 * Consistent with the SDK's `:thread:` separator convention.
 */
export function threadScopedKey(base: string, threadId?: string): string {
  return threadId ? `${base}:thread:${threadId}` : base;
}

export function buildQueueKey(accountId: string, chatId: string, threadId?: string): string {
  return threadScopedKey(`${accountId}:${chatId}`, threadId);
}

export function registerActiveDispatcher(key: string, entry: ActiveDispatcherEntry): void {
  activeDispatchers.set(key, entry);
}

export function unregisterActiveDispatcher(key: string): void {
  activeDispatchers.delete(key);
}

export function getActiveDispatcher(key: string): ActiveDispatcherEntry | undefined {
  return activeDispatchers.get(key);
}

/** Check whether the queue has an active task for the given key. */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(key);
}

export function enqueueFeishuChatTask(params: {
  accountId: string;
  chatId: string;
  threadId?: string;
  task: () => Promise<void>;
  /** Per-task deadline in ms.  After this the chain proceeds even if the
   *  task hasn't resolved, preventing a stuck dispatch from blocking the
   *  entire chat queue forever.  Default: 10 minutes. */
  taskTimeoutMs?: number;
}): { status: QueueStatus; promise: Promise<void> } {
  const { accountId, chatId, threadId, task, taskTimeoutMs } = params;
  const key = buildQueueKey(accountId, chatId, threadId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const status: QueueStatus = chatQueues.has(key) ? 'queued' : 'immediate';

  const timeout = taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  // Wrap the user-supplied task so it cannot hold the queue forever.
  // Promise.race does NOT cancel the underlying task — the LLM call
  // continues running — but it does let the Promise chain advance so
  // new messages can be processed.
  const guarded = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The task is still running (likely a hung LLM call / network
        // stall).  Resolve the queue slot so subsequent messages are
        // not blocked, but leave the task running in the background
        // so it can complete on its own.
        reject(
          new Error(
            `chat-queue task timed out after ${timeout}ms for ${key}`,
          ),
        );
      }, timeout);

      task()
        .then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        )
        .catch(() => {
          // Defensive: should have been caught above, but guard
          // against unhandled rejections.
          clearTimeout(timer);
          reject(new Error('chat-queue task threw unexpectedly'));
        });
    });
  };

  const taskPromise = prev.then(guarded, guarded);
  chatQueues.set(key, taskPromise);

  const cleanup = (): void => {
    if (chatQueues.get(key) === taskPromise) {
      chatQueues.delete(key);
    }
  };

  taskPromise.then(cleanup, cleanup);

  // Suppress unhandled rejection noise for timed-out tasks — the
  // rejection was intentionally used to unblock the queue.
  taskPromise.catch(() => {});

  return { status, promise: taskPromise };
}

/** @internal Test-only: reset all queue and dispatcher state. */
export function _resetChatQueueState(): void {
  chatQueues.clear();
  activeDispatchers.clear();
}
