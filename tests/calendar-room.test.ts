import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
}

const state = vi.hoisted(() => ({
  invokeByPath: vi.fn(),
  registeredTools: [] as RegisteredTool[],
}));

vi.mock('../src/tools/oapi/helpers', () => ({
  handleInvokeErrorWithAutoAuth: vi.fn(),
  parseTimeToRFC3339: (input: string) => (input.includes('invalid') ? null : input.includes('T') ? input : `${input.replace(' ', 'T')}+08:00`),
  createToolContext: () => ({
    toolClient: () => ({
      invokeByPath: state.invokeByPath,
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }),
  json: (data: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(data) }],
    details: data,
  }),
  registerTool: (api: { registerTool: (tool: RegisteredTool) => void }, tool: RegisteredTool) => {
    api.registerTool(tool);
    return true;
  },
}));

vi.mock('../src/tools/helpers', () => ({
  getResolvedConfig: () => ({
    channels: {
      feishu: {
        meetingRooms: {
          workplaces: [
            { name: '中建', aliases: ['中建'], matchFields: ['path', 'name'] },
            { name: '惠通', aliases: ['惠通'], matchFields: ['path', 'name'] },
          ],
        },
      },
    },
  }),
}));

import { registerFeishuCalendarRoomTool } from '../src/tools/oapi/calendar/room';

function registerTools(): RegisteredTool[] {
  state.registeredTools = [];
  const api = {
    config: {},
    registerTool: (tool: RegisteredTool) => state.registeredTools.push(tool),
  };
  registerFeishuCalendarRoomTool(api as never);
  return state.registeredTools;
}

function getRoomTool(): RegisteredTool {
  const tool = registerTools().find((candidate) => candidate.name === 'feishu_calendar_room');
  if (!tool) throw new Error('feishu_calendar_room was not registered');
  return tool;
}

beforeEach(() => {
  state.invokeByPath.mockReset();
  state.registeredTools = [];
});

describe('feishu_calendar_room', () => {
  it('filters searched rooms by inferred workplace from query', async () => {
    state.invokeByPath.mockResolvedValue({
      data: {
        rooms: [
          { room_id: 'omm-a', name: '海王星', path: '中建/A区/3F' },
          { room_id: 'omm-b', name: '海王星', path: '惠通/B区/3F' },
        ],
        has_more: false,
      },
    });

    const result = await getRoomTool().execute('call-1', { action: 'search', query: '中建 海王星' });

    expect(state.invokeByPath).toHaveBeenCalledWith(
      'feishu_calendar_room.search',
      '/open-apis/vc/v1/rooms/search',
      expect.objectContaining({ as: 'user' }),
    );
    expect(result.details).toEqual({
      rooms: [
        {
          room_id: 'omm-a',
          name: '海王星',
          description: undefined,
          display_id: undefined,
          custom_room_id: undefined,
          room_level_id: undefined,
          path: '中建/A区/3F',
          location: '中建/A区/3F',
          capacity: undefined,
          room_status: undefined,
          status: undefined,
          schedule_status: undefined,
          disable_start_time: undefined,
          disable_end_time: undefined,
          disable_reason: undefined,
          contact_ids: undefined,
          device: undefined,
        },
      ],
      has_more: false,
      page_token: undefined,
      workplace: '中建',
    });
  });

  it('returns structured error for unknown workplace', async () => {
    const result = await getRoomTool().execute('call-2', {
      action: 'search',
      query: '海王星',
      workplace: '不存在的职场',
    });

    expect(state.invokeByPath).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      error: 'unknown_workplace',
      workplace: '不存在的职场',
      supported_workplaces: ['中建', '惠通'],
    });
  });

  it('checks availability and reports missing rooms', async () => {
    state.invokeByPath
      .mockResolvedValueOnce({ data: { room: { room_id: 'omm-a', name: '海王星' } } })
      .mockResolvedValueOnce({ data: { freebusy_list: [] } })
      .mockResolvedValueOnce({ data: { room: {} } });

    const result = await getRoomTool().execute('call-3', {
      action: 'availability',
      time_min: '2026-04-28 15:00:00',
      time_max: '2026-04-28 16:00:00',
      room_ids: ['omm-a', 'omm-missing'],
    });

    expect(result.details).toEqual({
      availability: [
        { room_id: 'omm-a', name: '海王星', is_available: true, busy_ranges: [] },
        { room_id: 'omm-missing', is_available: false, busy_ranges: [], error: 'room not found' },
      ],
      _debug: {
        time_min_input: '2026-04-28 15:00:00',
        time_max_input: '2026-04-28 16:00:00',
        time_min_rfc3339: '2026-04-28T15:00:00+08:00',
        time_max_rfc3339: '2026-04-28T16:00:00+08:00',
      },
    });
  });
});
