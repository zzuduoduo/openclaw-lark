import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ticket: undefined as { chatId?: string } | undefined,
  registeredTools: [] as RegisteredTool[],
  list: vi.fn(),
  invokeWithAuth: vi.fn(),
}));

vi.mock('../src/core/lark-ticket', () => ({
  getTicket: () => state.ticket,
}));

vi.mock('../src/tools/oapi/helpers', () => ({
  StringEnum: (values: string[], options?: Record<string, unknown>) => ({ type: 'string', enum: values, ...options }),
  assertLarkOk: (res: { code?: number; msg?: string }) => {
    if (res.code !== undefined && res.code !== 0) {
      throw Object.assign(new Error(res.msg ?? 'Lark API error'), { code: res.code, msg: res.msg });
    }
  },
  createToolContext: () => ({
    getClient: () => ({
      im: {
        v1: {
          message: {
            list: state.list,
          },
        },
      },
    }),
    toolClient: () => ({
      invokeWithAuth: state.invokeWithAuth,
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }),
  formatLarkError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  getFirstAccount: () => ({ accountId: 'default' }),
  handleInvokeErrorWithAutoAuth: vi.fn(),
  json: (data: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    details: data,
  }),
  registerTool: (api: { registerTool: (tool: RegisteredTool) => void }, tool: RegisteredTool) => {
    api.registerTool(tool);
    return true;
  },
}));

import { registerMessageReadTools } from '../src/tools/oapi/im/message-read';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
}

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
}

function registerTools(): RegisteredTool[] {
  state.registeredTools = [];
  const api = {
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: (tool: RegisteredTool) => {
      state.registeredTools.push(tool);
    },
  };

  registerMessageReadTools(api as never);
  return state.registeredTools;
}

function getBotTool(): RegisteredTool {
  const tool = registerTools().find((candidate) => candidate.name === 'feishu_im_bot_get_messages');
  if (!tool) {
    throw new Error('feishu_im_bot_get_messages was not registered');
  }
  return tool;
}

beforeEach(() => {
  state.ticket = undefined;
  state.registeredTools = [];
  state.list.mockReset();
  state.invokeWithAuth.mockReset();
});

describe('feishu_im_bot_get_messages', () => {
  it('uses the current group context when chat_id is omitted', async () => {
    state.ticket = { chatId: 'oc_current' };
    state.list.mockResolvedValue({
      code: 0,
      data: {
        items: [],
        has_more: false,
      },
    });

    const result = await getBotTool().execute('call-1', { relative_time: 'today' });

    expect(state.list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'chat',
        container_id: 'oc_current',
      }),
    });
    expect(state.invokeWithAuth).not.toHaveBeenCalled();
    expect(result.details).toEqual({ messages: [], has_more: false, page_token: undefined });
  });

  it('rejects a chat_id outside the current group context', async () => {
    state.ticket = { chatId: 'oc_current' };

    const result = await getBotTool().execute('call-1', { chat_id: 'oc_other' });

    expect(state.list).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      error: 'chat_not_allowed',
      chat_id: 'oc_other',
      allowed_chat_id: 'oc_current',
    });
  });

  it('maps missing app scope errors to a structured error', async () => {
    state.ticket = { chatId: 'oc_current' };
    state.list.mockRejectedValue(Object.assign(new Error('missing scope'), { code: 99991672, msg: 'missing scope' }));

    const result = await getBotTool().execute('call-1', {});

    expect(result.details).toEqual({
      error: 'missing_app_scope',
      message: 'missing scope',
      code: 99991672,
    });
  });

  it('maps bot membership errors to a structured error', async () => {
    state.ticket = { chatId: 'oc_current' };
    state.list.mockRejectedValue(
      Object.assign(new Error('bot is not in chat'), { code: 230020, msg: 'bot is not in chat' }),
    );

    const result = await getBotTool().execute('call-1', {});

    expect(result.details).toEqual({
      error: 'bot_not_in_chat',
      message: 'bot is not in chat',
      code: 230020,
    });
  });
});
