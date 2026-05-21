/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu interactive dispatch wrapper.
 *
 * This module adapts Feishu `card.action.trigger` events into OpenClaw's
 * standard interactive dispatch pipeline:
 * - Plugins register via `api.registerInteractiveHandler({ channel, namespace, handler })`
 * - Channel forwards via `dispatchPluginInteractiveHandler()`
 *
 * Supports two event formats:
 * 1. Standard interactive action: `action.value.action` (e.g., "confirm_order")
 * 2. Business form submission: `action.value` contains custom key-value data + `action.form_value`
 *
 * We intentionally do NOT maintain any channel-local global registry here.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
// NOTE: This is the SDK-standard interactive pipeline.
import { dispatchPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';
import { larkLogger } from '../core/lark-logger';
import { sendCardFeishu, sendMessageFeishu, updateCardFeishu } from '../messaging/outbound/send';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { enqueueFeishuChatTask } from './chat-queue';
import { withTicket } from '../core/lark-ticket';

/** Max retries for synthetic message injection. */
const INJECT_MAX_RETRIES = 2;
/** Delay between retry attempts (ms). */
const INJECT_RETRY_DELAY_MS = 2000;

const log = larkLogger('channel/interactive-dispatch');

/**
 * Extended Feishu card action trigger event structure.
 * Supports both standard interactive actions and business form submissions.
 */
interface FeishuCardActionTriggerEvent {
  operator?: { open_id?: string };
  open_chat_id?: string;
  open_message_id?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: {
    tag?: string;
    name?: string;
    value?: Record<string, unknown>;
    /** Form submission data when the card contains form elements. */
    form_value?: Record<string, unknown>;
  };
}

/**
 * Extracted card action basics for dispatch.
 */
interface CardActionBasics {
  action: string;
  senderOpenId?: string;
  openChatId?: string;
  openMessageId?: string;
  /** Form submission data (for business forms). */
  formValue?: Record<string, unknown>;
  /** Custom value data from the action. */
  customValue?: Record<string, unknown>;
}

/**
 * Extract basics from a card action trigger event.
 *
 * Supports two formats:
 * 1. Standard action: `action.value.action` is a non-empty string
 * 2. Business form: `action.value` contains custom key-value data (may include form_value)
 *
 * For business forms, the `action` is derived from:
 * - `action.value.action` if present and non-empty
 * - `action.name` if present and starts with a known prefix
 * - A default "form_submit" action
 */
function extractBasics(data: unknown): CardActionBasics | null {
  try {
    const ev = data as FeishuCardActionTriggerEvent;
    const openChatId = ev.open_chat_id ?? ev.context?.open_chat_id;
    const openMessageId = ev.open_message_id ?? ev.context?.open_message_id;
    const senderOpenId = ev.operator?.open_id;
    const actionValue = ev.action?.value;
    const formValue = ev.action?.form_value;
    

    // Case 1: Standard interactive action with explicit action field
    const explicitAction = actionValue?.action;
    if (typeof explicitAction === 'string' && explicitAction.trim()) {
      return {
        action: explicitAction.trim(),
        senderOpenId,
        openChatId,
        openMessageId,
        formValue,
        customValue: actionValue,
      };
    }

    // Case 2: Business form submission (value contains custom data, not an action string)
    // A business form typically has:
    // - form_value containing submitted form field data
    // - value containing developer-defined custom data
    if (formValue || (actionValue && Object.keys(actionValue).length > 0)) {
      // Derive action from button name or use default
      let action = 'form_submit';
      if (ev.action?.name) {
        // Button name format: "prefix_<id>" (e.g., "biz_form_submit_123")
        action = `form:${ev.action.name}`;
      }
      return {
        action,
        senderOpenId,
        openChatId,
        openMessageId,
        formValue,
        customValue: actionValue,
      };
    }

    // No actionable data found
    return null;
  } catch {
    return null;
  }
}

export type FeishuInteractiveHandlerResponse = unknown;

type FeishuPluginInteractiveDispatch = (params: {
  channel: 'feishu';
  data: string;
  dedupeId: string;
  invoke: (match: {
    registration: { handler: (ctx: FeishuInteractiveHandlerContext) => Promise<unknown> | unknown };
    namespace: string;
    payload: string;
  }) => Promise<{ handled: boolean }>;
}) => Promise<{ matched: boolean }>;

export interface FeishuInteractiveHandlerContext {
  channel: 'feishu';
  accountId: string;
  /** OpenClaw config for making outbound API calls. */
  cfg: ClawdbotConfig;
  senderId?: string;
  conversationId?: string;
  messageId?: string;
  namespace: string;
  payload: string;
  action: string;
  rawEvent: unknown;
  /** Form submission data (for business form cards). */
  formValue?: Record<string, unknown>;
  /** Custom value data from the action. */
  customValue?: Record<string, unknown>;
  respond: {
    reply: (args: { text: string }) => Promise<void>;
    followUp: (args: { text: string }) => Promise<void>;
    /**
     * Best-effort "edit current message" mapping.
     * In Feishu, we prefer updating the original interactive card when possible.
     */
    editMessage: (args: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
}

function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

/**
 * Format form data for display in card and synthetic message.
 */
function formatFormData(
  formValue?: Record<string, unknown>,
  customValue?: Record<string, unknown>
): string {
  const lines: string[] = [];

  if (formValue && Object.keys(formValue).length > 0) {
    lines.push('**表单数据:**');
    for (const [key, value] of Object.entries(formValue)) {
      const displayKey = key.replace(/_/g, ' ');
      lines.push(`- ${displayKey}: ${value ?? '(空)'}`);
    }
  }

  if (customValue && Object.keys(customValue).length > 0) {
    lines.push('');
    lines.push('**自定义数据:**');
    for (const [key, value] of Object.entries(customValue)) {
      if (key === 'action') continue; // Skip the action field
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    }
  }

  return lines.join('\n') || '无数据';
}

/**
 * Build a processing card to show after form submission.
 */
function buildProcessingCard(formFields: string): Record<string, unknown> {
  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '✅ **表单已提交，正在处理...**\n\n' + formFields,
        },
        {
          tag: 'divider',
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: '处理完成后会通知您',
            },
          ],
        },
      ],
    },
  };
}

/**
 * Inject a synthetic message carrying the form submission data so the AI agent
 * receives them in a new turn.
 */
async function injectFormSyntheticMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId: string;
  formValue?: Record<string, unknown>;
  customValue?: Record<string, unknown>;
  action: string;
}): Promise<void> {
  const { cfg, accountId, chatId, senderOpenId, messageId, formValue, customValue, action } = params;

  const syntheticMsgId = `${messageId}:business-form:${action}`;
  const syntheticRuntime = {
    log: (msg: string) => log.info(msg),
    error: (msg: string) => log.error(msg),
  };

  // Build the form data summary for the AI
  const formSummary = formatFormData(formValue, customValue);
  const text = `📋 **用户提交了业务表单**\n\n${formSummary}`;

  log.info(`[interactive-dispatch] Injecting synthetic message: ${syntheticMsgId}`);

  let lastError: unknown;
  for (let attempt = 0; attempt <= INJECT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log.info(`[interactive-dispatch] Retrying synthetic message injection (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, INJECT_RETRY_DELAY_MS));
    }

    try {
      const { status, promise } = enqueueFeishuChatTask({
        accountId,
        chatId,
        task: async () => {
          await withTicket(
            {
              messageId: syntheticMsgId,
              chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId,
              chatType: 'p2p',
            },
            () =>
              handleFeishuMessage({
                cfg,
                event: {
                  sender: { sender_id: { open_id: senderOpenId } },
                  message: {
                    message_id: syntheticMsgId,
                    chat_id: chatId,
                    chat_type: 'p2p',
                    message_type: 'text',
                    content: JSON.stringify({ text }),
                  },
                } as unknown as Parameters<typeof handleFeishuMessage>[0]['event'],
                accountId,
                forceMention: true,
                runtime: syntheticRuntime as Parameters<typeof handleFeishuMessage>[0]['runtime'],
                replyToMessageId: messageId,
              }),
          );
        },
      });

      // Wait for the task to actually execute (not just enqueue)
      await promise;
      log.info(`[interactive-dispatch] Synthetic message dispatched (${status}): ${syntheticMsgId}, content: ${text}`);
      return; // success
    } catch (err) {
      lastError = err;
      log.warn(`[interactive-dispatch] Synthetic message injection attempt ${attempt + 1} failed: ${err}`);
    }
  }

  // All retries exhausted
  log.error(
    `[interactive-dispatch] Synthetic message injection failed after ${INJECT_MAX_RETRIES + 1} attempts: ${lastError}`,
  );
}

/**
 * Dispatch a Feishu interactive card action to business plugins through
 * the OpenClaw SDK's standard interactive dispatch pipeline.
 *
 * Returns `undefined` when:
 * - the event does not look like an interactive action we can route, or
 * - no plugin handler is registered for the derived namespace.
 *
 * @param params.cfg - OpenClaw config snapshot.
 * @param params.accountId - Current Feishu account id.
 * @param params.data - Raw `card.action.trigger` event payload.
 */
export async function dispatchFeishuPluginInteractiveHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  data: unknown;
}): Promise<unknown | undefined> {
  log.info(`[interactive-dispatch] Received card action: ${JSON.stringify(params.data).slice(0, 200)}`);

  const basics = extractBasics(params.data);
  if (!basics) {
    log.info(`[interactive-dispatch] No basics extracted from action, returning undefined`);
    return undefined;
  }
  if (!basics.action) {
    log.info(`[interactive-dispatch] No action in basics, returning undefined`);
    return undefined;
  }

  // Handle all form-related actions (e.g., "form:submit", "form:submit_order_123")
  if (basics.action.startsWith('form:')) {
    log.info('[interactive-dispatch] Handling form action', {
      action: basics.action,
      formValue: basics.formValue,
      customValue: basics.customValue,
      chatId: basics.openChatId,
      sender: basics.senderOpenId,
    });

    // Merge customValue into formValue for AI processing
    // This ensures all form data is available in one place
    const mergedFormValue = { ...basics.formValue };
    if (basics.customValue) {
      for (const [key, value] of Object.entries(basics.customValue)) {
        // Skip the 'action' field as it's already in the action string
        //if (key !== 'action') {
        mergedFormValue[key] = value;
        //}
      }
    }
    // Add openMessageId to mergedFormValue for AI processing
    if (basics.openMessageId) {
      mergedFormValue.openMessageId = basics.openMessageId;
    }

    // Build a user-friendly summary of the form submission
    const formFields = formatFormData(mergedFormValue);

    // Schedule synthetic message injection after returning the card response.
    // This is non-blocking - the user sees immediate feedback.
    setImmediate(() => {
      injectFormSyntheticMessage({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId: basics.openChatId ?? '',
        senderOpenId: basics.senderOpenId ?? '',
        messageId: basics.openMessageId ?? '',
        formValue: mergedFormValue,
        customValue: basics.customValue,
        action: basics.action,
      }).catch((err) => {
        log.error(`[interactive-dispatch] unhandled error in injectFormSyntheticMessage: ${err}`);
      });
    });

    // Return immediate visual feedback via Feishu callback response
    // Note: Feishu expects card wrapped as { type: "raw", data: {...} }
    return {
      toast: { type: 'success', content: '表单已提交，正在处理...' },
      card: {
        type: 'raw',
        data: buildProcessingCard(formFields),
      },
    };
  }

  log.info(`[interactive-dispatch] Dispatching action: ${basics.action}, chatId: ${basics.openChatId}, messageId: ${basics.openMessageId}`);

  const respond: FeishuInteractiveHandlerContext['respond'] = {
    reply: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    followUp: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    editMessage: async (args: { text?: string; blocks?: unknown[] }) => {
      if (!basics.openMessageId) {
        if (Array.isArray(args?.blocks) && args.blocks.length && basics.openChatId) {
          await sendCardFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
          return;
        }
        if (typeof args?.text === 'string' && args.text.trim() && basics.openChatId) {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            text: args.text,
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
        }
        return;
      }
      if (Array.isArray(args?.blocks) && args.blocks.length) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
          accountId: params.accountId,
        });
        return;
      }
      if (typeof args?.text === 'string' && args.text.trim()) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: buildMarkdownCard(args.text),
          accountId: params.accountId,
        });
        return;
      }
      await updateCardFeishu({
        cfg: params.cfg,
        messageId: basics.openMessageId,
        card: { schema: '2.0', body: { elements: [] } },
        accountId: params.accountId,
      });
    },
  };

  try {
    const dedupeId = `feishu:${params.accountId}:${basics.openChatId ?? '-'}:${basics.openMessageId ?? '-'}:${
      basics.senderOpenId ?? '-'
    }:${basics.action}`;

    log.info(`[interactive-dispatch] Calling SDK dispatchPluginInteractiveHandler with data="${basics.action}"`);

    let cardResponse: FeishuInteractiveHandlerResponse | undefined;
    const dispatchFeishuInteractiveHandler =
      dispatchPluginInteractiveHandler as unknown as FeishuPluginInteractiveDispatch;
    const result = await dispatchFeishuInteractiveHandler({
      channel: 'feishu',
      data: basics.action,
      dedupeId,
      invoke: async (match: {
        registration: { handler: (ctx: FeishuInteractiveHandlerContext) => Promise<unknown> | unknown };
        namespace: string;
        payload: string;
      }) => {
        log.info(`[interactive-dispatch] >>> SDK matched: namespace=${match.namespace}, payload=${match.payload}`);
        const { registration, namespace, payload } = match;
        const handlerCtx: FeishuInteractiveHandlerContext = {
          channel: 'feishu',
          accountId: params.accountId,
          cfg: params.cfg,
          senderId: basics.senderOpenId,
          conversationId: basics.openChatId,
          messageId: basics.openMessageId,
          namespace,
          payload,
          action: basics.action,
          rawEvent: params.data,
          formValue: basics.formValue,
          customValue: basics.customValue,
          respond,
        };
        log.info(`[interactive-dispatch] >>> Calling registration.handler...`);
        cardResponse = await registration.handler(handlerCtx);
        log.info(`[interactive-dispatch] >>> registration.handler returned: ${JSON.stringify(cardResponse)}`);
        // If the handler returns a card response, treat it as handled.
        return { handled: cardResponse !== undefined };
      },
    });

    log.info(`[interactive-dispatch] SDK dispatchPluginInteractiveHandler returned: matched=${result.matched}`);

    if (!result.matched) {
      log.info(`[interactive-dispatch] >>> SDK did NOT match any handler for action: ${basics.action}`);
      return undefined;
    }
    log.info(`[interactive-dispatch] >>> Handler matched, returning cardResponse`);
    return cardResponse;
  } catch (err) {
    log.warn(`interactive dispatch failed: ${String(err)}`);
    return {
      toast: {
        type: 'error',
        content: '交互处理失败，请稍后重试',
      },
    };
  }
}
