import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
}

const state = vi.hoisted(() => ({
  registeredTools: [] as RegisteredTool[],
  invoke: vi.fn(),
}));

vi.mock('../src/tools/oapi/helpers', () => ({
  StringEnum: (values: string[], options?: Record<string, unknown>) => ({ type: 'string', enum: values, ...options }),
  assertLarkOk: (res: { code?: number; msg?: string }) => {
    if (res.code !== undefined && res.code !== 0) {
      throw Object.assign(new Error(res.msg ?? 'Lark API error'), { code: res.code, msg: res.msg });
    }
  },
  createToolContext: () => ({
    toolClient: () => ({
      invoke: state.invoke,
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }),
  formatLarkError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  handleInvokeErrorWithAutoAuth: vi.fn(),
  json: (data: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(data) }],
    details: data,
  }),
  parseTimeToTimestamp: (input: string) => (input.includes('invalid') ? null : '1714287600'),
  registerTool: (api: { registerTool: (tool: RegisteredTool) => void }, tool: RegisteredTool) => {
    api.registerTool(tool);
    return true;
  },
  unixTimestampToISO8601: () => '2026-04-28T15:00:00+08:00',
}));

import { registerFeishuCalendarEventTool } from '../src/tools/oapi/calendar/event';

function registerTools(): RegisteredTool[] {
  state.registeredTools = [];
  const api = {
    config: {},
    registerTool: (tool: RegisteredTool) => state.registeredTools.push(tool),
  };
  registerFeishuCalendarEventTool(api as never);
  return state.registeredTools;
}

function getEventTool(): RegisteredTool {
  const tool = registerTools().find((candidate) => candidate.name === 'feishu_calendar_event');
  if (!tool) throw new Error('feishu_calendar_event was not registered');
  return tool;
}

beforeEach(() => {
  state.invoke.mockReset();
  state.registeredTools = [];
});

describe('feishu_calendar_event.create room booking result', () => {
  it('returns pending room booking state for needs_action attendees', async () => {
    state.invoke
      .mockResolvedValueOnce({ data: { calendars: [{ calendar: { calendar_id: 'cal_primary' } }] } })
      .mockResolvedValueOnce({
        code: 0,
        data: { event: { event_id: 'evt_1', summary: '项目会', app_link: 'https://example.com/event' } },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          attendees: [{ room_id: 'omm_1', rsvp_status: 'needs_action' }],
        },
      });

    const result = await getEventTool().execute('call-1', {
      action: 'create',
      summary: '项目会',
      start_time: '2026-04-28T15:00:00+08:00',
      end_time: '2026-04-28T16:00:00+08:00',
      user_open_id: 'ou_1',
      attendees: [{ type: 'resource', id: 'omm_1' }],
    });

    expect(result.details).toMatchObject({
      event: {
        event_id: 'evt_1',
        summary: '项目会',
      },
      resource_attendees: [
        {
          room_id: 'omm_1',
          status: 'success',
          booking_state: 'pending',
          rsvp_status: 'needs_action',
        },
      ],
      resource_booking_status: 'success',
    });
  });

  it('returns failed room booking state when attendee creation fails', async () => {
    state.invoke
      .mockResolvedValueOnce({ data: { calendars: [{ calendar: { calendar_id: 'cal_primary' } }] } })
      .mockResolvedValueOnce({
        code: 0,
        data: { event: { event_id: 'evt_2', summary: '项目会', app_link: 'https://example.com/event' } },
      })
      .mockRejectedValueOnce(new Error('resource permission denied'));

    const result = await getEventTool().execute('call-2', {
      action: 'create',
      summary: '项目会',
      start_time: '2026-04-28T15:00:00+08:00',
      end_time: '2026-04-28T16:00:00+08:00',
      user_open_id: 'ou_1',
      attendees: [{ type: 'resource', id: 'omm_1' }],
    });

    expect(result.details).toMatchObject({
      warning: '日程已创建，但添加参会人失败：resource permission denied',
      resource_attendees: [
        {
          room_id: 'omm_1',
          status: 'failed',
          booking_state: 'unknown',
          error: 'resource permission denied',
        },
      ],
      resource_booking_status: 'partial_success',
    });
  });

  it('keeps plain event creation response unchanged when no room attendee exists', async () => {
    state.invoke
      .mockResolvedValueOnce({ data: { calendars: [{ calendar: { calendar_id: 'cal_primary' } }] } })
      .mockResolvedValueOnce({
        code: 0,
        data: { event: { event_id: 'evt_3', summary: '普通会议', app_link: 'https://example.com/event' } },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          attendees: [{ user_id: 'ou_1', rsvp_status: 'accept' }],
        },
      });

    const result = await getEventTool().execute('call-3', {
      action: 'create',
      summary: '普通会议',
      start_time: '2026-04-28T15:00:00+08:00',
      end_time: '2026-04-28T16:00:00+08:00',
      user_open_id: 'ou_1',
    });

    const details = result.details as Record<string, unknown>;
    expect(details.resource_attendees).toBeUndefined();
    expect(details.resource_booking_status).toBeUndefined();
  });
});
