import { beforeEach, describe, expect, it, vi } from 'vitest';

const ticketState = vi.hoisted(() => ({
  value: undefined as { senderOpenId?: string } | undefined,
}));

vi.mock('../src/core/lark-ticket', () => ({
  getTicket: () => ticketState.value,
}));

import { getUserInfoCache } from '../src/messaging/inbound/user-name-cache';
import { registerGetUserCacheTool } from '../src/tools/oapi/common/get-user';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
}

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
}

function createApi() {
  let registeredTool: RegisteredTool | undefined;
  const api = {
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: (tool: unknown) => {
      if (tool && typeof tool === 'object' && 'name' in tool && 'execute' in tool) {
        registeredTool = tool as RegisteredTool;
      }
    },
  };

  registerGetUserCacheTool(api as never);
  if (!registeredTool) {
    throw new Error('feishu_get_user_cache was not registered');
  }
  return registeredTool;
}

beforeEach(() => {
  ticketState.value = undefined;
  getUserInfoCache().clear();
  vi.clearAllMocks();
});

describe('feishu_get_user_cache', () => {
  it('returns an error when senderOpenId is unavailable', async () => {
    const tool = createApi();

    const result = await tool.execute('call-1', {});

    expect(result.details).toEqual({
      error: '无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。',
    });
  });

  it('returns a cache miss for the current sender when no cached user exists', async () => {
    ticketState.value = { senderOpenId: 'ou_sender' };
    const tool = createApi();

    const result = await tool.execute('call-1', {});

    expect(result.details).toEqual({
      open_id: 'ou_sender',
      cache_hit: false,
      user: null,
    });
  });

  it('returns cached user info for the current sender', async () => {
    ticketState.value = { senderOpenId: 'ou_sender' };
    getUserInfoCache().set('ou_sender', {
      name: 'Alice',
      email: 'alice@example.com',
      mobile: '123456789',
      employeeNo: 'E123',
      fetchedAt: 1234567890,
    });
    const tool = createApi();

    const result = await tool.execute('call-1', {});

    expect(result.details).toEqual({
      open_id: 'ou_sender',
      cache_hit: true,
      user: {
        open_id: 'ou_sender',
        name: 'Alice',
        email: 'alice@example.com',
        mobile: '123456789',
        employeeNo: 'E123',
        fetchedAt: 1234567890,
      },
    });
  });
});
