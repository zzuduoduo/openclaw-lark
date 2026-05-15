/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Business Interactive Plugin
 *
 * Demonstrates how to handle standard interactive actions and business form submissions
 * through the OpenClaw SDK's interactive dispatch pipeline.
 *
 * Match Logic (from SDK's dispatchPluginInteractiveHandler):
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  1. Extract `data` string from card action (e.g., "order:confirm_123")      │
 * │  2. Parse with format: `namespace:payload`                                  │
 * │     - namespace = text before first ":"                                     │
 * │     - payload = text after first ":"                                        │
 * │  3. Look up handler registered with { channel, namespace }                 │
 * │  4. If found, invoke handler with { namespace, payload, registration }      │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Examples:
 * - Standard action: "order:confirm_123" → namespace="order", payload="confirm_123"
 * - Business form: "form:submit_btn_123" → namespace="form", payload="submit_btn_123"
 */

import type { ClawdbotConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { withTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';
import { enqueueFeishuChatTask } from '../channel/chat-queue';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import type { FeishuInteractiveHandlerContext } from '../channel/interactive-dispatch';

/** SDK handler result type */
type HandlerResult = { handled?: boolean } | void;

/** Max retries for synthetic message injection. */
const INJECT_MAX_RETRIES = 2;

/** Delay between retry attempts (ms). */
const INJECT_RETRY_DELAY_MS = 2000;

const log = larkLogger('plugins/business-interactive-handler');

/**
 * Standard interactive action handlers.
 * These handle actions like "order:confirm", "payment:process", etc.
 */
const standardActionHandlers: Record<string, (payload: string, ctx: FeishuInteractiveHandlerContext) => Promise<HandlerResult>> = {
  // Example: "order:confirm_123" → order.confirm
  order: async (payload) => {
    const orderId = payload.replace('confirm_', '');
    console.log(`[business-plugin] Order confirmation: ${orderId}`);
    return { handled: true, toast: { type: 'success', content: `订单 ${orderId} 已确认` } } as HandlerResult;
  },

  // Example: "payment:process_456" → payment.process
  payment: async (payload) => {
    const paymentId = payload.replace('process_', '');
    console.log(`[business-plugin] Payment processing: ${paymentId}`);
    return { handled: true, toast: { type: 'success', content: `支付 ${paymentId} 处理中` } } as HandlerResult;
  },
};

/**
 * Business form submission handler.
 * This handles all form submissions with namespace "form".
 *
 * In Feishu console, you can configure custom form cards.
 * When users submit these forms, the callback includes:
 * - action.value: developer-defined custom data
 * - action.form_value: submitted form field values
 *
 * After returning the immediate card response, this function schedules a
 * synthetic message injection to send the form data to the AI agent.
 */
async function handleFormSubmission(ctx: FeishuInteractiveHandlerContext): Promise<HandlerResult> {
  const { formValue, customValue, action, payload, cfg, accountId, senderId, conversationId, messageId } = ctx;

  log.info(`[business-plugin] Form submission: ${action}`, {
    formValue,
    customValue,
    payload,
    chatId: conversationId,
    sender: senderId,
  });

  // Build a user-friendly summary of the form submission
  const formFields = formatFormData(formValue, customValue);

  // Update card to show processing state
  const processingCard = buildProcessingCard(formFields);

  // Schedule synthetic message injection after returning the card response.
  // This is non-blocking - the user sees immediate feedback.
  setImmediate(() => {
    injectFormSyntheticMessage({
      cfg,
      accountId,
      chatId: conversationId ?? '',
      senderOpenId: senderId ?? '',
      messageId: messageId ?? '',
      formValue,
      customValue,
      action,
      payload,
    }).catch((err) => {
      log.error(`[business-plugin] unhandled error in injectFormSyntheticMessage: ${err}`);
    });
  });

  // Return immediate visual feedback via Feishu callback response
  return {
    handled: true,
    toast: { type: 'success', content: '表单已提交，正在处理...' },
    card: processingCard,
  } as HandlerResult;
}

/**
 * Standard action handler dispatcher.
 * Routes to appropriate handler based on namespace (already parsed by SDK).
 */
async function handleStandardAction(ctx: FeishuInteractiveHandlerContext): Promise<HandlerResult> {
  const { namespace, payload } = ctx;

  // SDK already parsed "namespace:payload" → ctx.namespace, ctx.payload
  // Now we just look up the handler by namespace
  const handler = standardActionHandlers[namespace];

  if (!handler) {
    log.warn(`[business-plugin] No handler for namespace: ${namespace}`);
    return { handled: true, toast: { type: 'error', content: `未知的操作类型: ${namespace}` } } as HandlerResult;
  }

  log.info(`[business-plugin] Calling handler for namespace=${namespace}, payload=${payload}`);
  return handler(payload, ctx);
}

/**
 * Main interactive handler that routes to appropriate handler based on namespace.
 */
async function businessInteractiveHandler(ctx: FeishuInteractiveHandlerContext): Promise<HandlerResult> {
  const { namespace } = ctx;

  switch (namespace) {
    case 'form':
      // Business form submissions
      return handleFormSubmission(ctx);

    case 'order':
    case 'payment':
      // Standard interactive actions
      return handleStandardAction(ctx);

    default:
      console.warn(`[business-plugin] Unknown namespace: ${namespace}`);
      return { handled: true, toast: { type: 'error', content: `未处理的操作: ${namespace}` } } as HandlerResult;
  }
}

// ---------------------------------------------------------------------------
// Plugin Registration
// ---------------------------------------------------------------------------

/**
 * Register business interactive handlers with the OpenClaw SDK.
 *
 * This function should be called during plugin initialization (e.g., in setup()).
 *
 * Registration format:
 * - channel: 'feishu' (matches the channel)
 * - namespace: handler identifier (used to route card actions)
 *
 * When a card action is triggered:
 * 1. SDK extracts `action.value.action` from the card callback
 * 2. SDK parses it as `namespace:payload`
 * 3. SDK invokes the registered handler for that namespace
 */
export function registerBusinessInteractiveHandlers(api: OpenClawPluginApi): void {
  // Register standard action handlers
  // Note: The SDK passes FeishuInteractiveHandlerContext (extended with formValue/customValue)
  api.registerInteractiveHandler({
    channel: 'feishu',
    namespace: 'order',
    handler: async (ctx): Promise<HandlerResult> => {
      const feishuCtx = ctx as FeishuInteractiveHandlerContext;
      return businessInteractiveHandler({
        ...feishuCtx,
        payload: feishuCtx.payload,
      });
    },
  });

  api.registerInteractiveHandler({
    channel: 'feishu',
    namespace: 'payment',
    handler: async (ctx): Promise<HandlerResult> => {
      const feishuCtx = ctx as FeishuInteractiveHandlerContext;
      return businessInteractiveHandler({
        ...feishuCtx,
        payload: feishuCtx.payload,
      });
    },
  });

  // Register business form handler
  // This handles all form submissions (namespace "form")
  api.registerInteractiveHandler({
    channel: 'feishu',
    namespace: 'form',
    handler: async (ctx): Promise<HandlerResult> => {
      const feishuCtx = ctx as FeishuInteractiveHandlerContext;
      // Extract button name from action for more specific handling
      // e.g., "form:submit_order_123" → "submit_order_123"
      const buttonName = feishuCtx.action.replace('form:', '');
      return businessInteractiveHandler({
        ...feishuCtx,
        payload: buttonName,
        formValue: feishuCtx.formValue,
        customValue: feishuCtx.customValue,
      });
    },
  });

  console.log('[business-plugin] Interactive handlers registered');
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Synthetic Message Injection
// ---------------------------------------------------------------------------

interface InjectSyntheticMessageParams {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId: string;
  formValue?: Record<string, unknown>;
  customValue?: Record<string, unknown>;
  action: string;
  payload: string;
}

/**
 * Inject a synthetic message carrying the form submission data so the AI agent
 * receives them in a new turn. Follows the same pattern as ask-user-question.ts
 * for synthetic message injection with retry support.
 */
async function injectFormSyntheticMessage(params: InjectSyntheticMessageParams): Promise<void> {
  const { cfg, accountId, chatId, senderOpenId, messageId, formValue, customValue, action } = params;

  const syntheticMsgId = `${messageId}:business-form:${action}`;
  const syntheticRuntime = {
    log: (msg: string) => log.info(msg),
    error: (msg: string) => log.error(msg),
  };

  // Build the form data summary for the AI
  const formSummary = formatFormDataForAI(formValue, customValue);
  const text = `📋 **用户提交了业务表单**\n\n${formSummary}`;

  log.info(`[business-plugin] Injecting synthetic message: ${syntheticMsgId}`);

  let lastError: unknown;
  for (let attempt = 0; attempt <= INJECT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log.info(`[business-plugin] Retrying synthetic message injection (attempt ${attempt + 1})`);
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                event: {
                  sender: { sender_id: { open_id: senderOpenId } },
                  message: {
                    message_id: syntheticMsgId,
                    chat_id: chatId,
                    chat_type: 'p2p',
                    message_type: 'text',
                    content: JSON.stringify({ text }),
                  },
                } as any,
                accountId,
                forceMention: true,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                runtime: syntheticRuntime as any,
                replyToMessageId: messageId,
              }),
          );
        },
      });

      // Wait for the task to actually execute (not just enqueue)
      await promise;
      log.info(`[business-plugin] Synthetic message dispatched (${status}): ${syntheticMsgId}`);
      return; // success
    } catch (err) {
      lastError = err;
      log.warn(`[business-plugin] Synthetic message injection attempt ${attempt + 1} failed: ${err}`);
    }
  }

  // All retries exhausted
  log.error(
    `[business-plugin] Synthetic message injection failed after ${INJECT_MAX_RETRIES + 1} attempts: ${lastError}`,
  );
}

/**
 * Format form data for AI consumption (more detailed than display format).
 */
function formatFormDataForAI(
  formValue?: Record<string, unknown>,
  customValue?: Record<string, unknown>
): string {
  const lines: string[] = [];

  if (formValue && Object.keys(formValue).length > 0) {
    lines.push('**表单字段:**');
    for (const [key, value] of Object.entries(formValue)) {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
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
