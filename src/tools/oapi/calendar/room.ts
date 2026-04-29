/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_calendar_room tool -- Discover meeting rooms and query availability.
 *
 * Actions:
 *   - list             List visible meeting room calendars
 *   - get              Get a single meeting room
 *   - search           Search meeting rooms by keyword
 *   - availability     Query whether room calendars are busy in a time range
 *   - search_available Search rooms then keep available ones only
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import {
  createToolContext,
  handleInvokeErrorWithAutoAuth,
  json,
  parseTimeToRFC3339,
  registerTool,
} from '../helpers';
import { getResolvedConfig } from '../../helpers';
import type { FeishuAccountConfig, FeishuConfig } from '../../../core/types';
import type { ToolContext } from '../../helpers';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const OPENAPI_DEFAULT_USER_ID_TYPE = 'open_id';

const RoomWorkplaceSchema = Type.Optional(
  Type.String({
    description: '职场名称，例如“中建”或“惠通”。传入后仅返回该职场下的会议室。',
  }),
);

const FeishuCalendarRoomSchema = Type.Union([
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Number({
        description: '每页返回的会议室数量（默认 20，最大 100）',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    workplace: RoomWorkplaceSchema,
  }),
  Type.Object({
    action: Type.Literal('get'),
    room_id: Type.String({
      description: '会议室 ID（omm_...）',
    }),
  }),
  Type.Object({
    action: Type.Literal('search'),
    query: Type.String({
      description: '会议室搜索关键词',
    }),
    page_size: Type.Optional(
      Type.Number({
        description: '每页返回的会议室数量（默认 20，最大 100）',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    workplace: RoomWorkplaceSchema,
  }),
  Type.Object({
    action: Type.Literal('availability'),
    time_min: Type.String({
      description: '查询起始时间（ISO 8601 / RFC 3339 格式（包含时区））',
    }),
    time_max: Type.String({
      description: '查询结束时间（ISO 8601 / RFC 3339 格式（包含时区））',
    }),
    room_ids: Type.Array(
      Type.String({
        description: '会议室 ID（omm_...）',
      }),
      {
        description: '要查询的会议室 ID 列表',
        minItems: 1,
        maxItems: 20,
      },
    ),
  }),
  Type.Object({
    action: Type.Literal('search_available'),
    time_min: Type.String({
      description: '查询起始时间（ISO 8601 / RFC 3339 格式（包含时区））',
    }),
    time_max: Type.String({
      description: '查询结束时间（ISO 8601 / RFC 3339 格式（包含时区））',
    }),
    query: Type.Optional(
      Type.String({
        description: '会议室搜索关键词；不传则在可见会议室范围内筛选可用房间',
      }),
    ),
    page_size: Type.Optional(
      Type.Number({
        description: '每页返回的会议室数量（默认 20，最大 100）',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    workplace: RoomWorkplaceSchema,
  }),
]);

type FeishuCalendarRoomParams =
  | {
      action: 'list';
      page_size?: number;
      page_token?: string;
      workplace?: string;
    }
  | {
      action: 'get';
      room_id: string;
    }
  | {
      action: 'search';
      query: string;
      page_size?: number;
      page_token?: string;
      workplace?: string;
    }
  | {
      action: 'availability';
      time_min: string;
      time_max: string;
      room_ids: string[];
    }
  | {
      action: 'search_available';
      time_min: string;
      time_max: string;
      query?: string;
      page_size?: number;
      page_token?: string;
      workplace?: string;
    };

interface WorkplaceConfig {
  name: string;
  aliases: string[];
  matchFields: string[];
}

interface RoomSummary {
  room_id?: string;
  name?: string;
  description?: string;
  display_id?: string;
  custom_room_id?: string;
  room_level_id?: string;
  path?: string;
  location?: string;
  capacity?: number;
  room_status?: Record<string, unknown>;
  status?: unknown;
  schedule_status?: unknown;
  disable_start_time?: unknown;
  disable_end_time?: unknown;
  disable_reason?: unknown;
  contact_ids?: unknown;
  device?: unknown;
}

interface RoomAvailabilityResult {
  room_id: string;
  name?: string;
  is_available: boolean;
  busy_ranges: Array<Record<string, unknown>>;
  error?: string;
}

function clampPageSize(pageSize: number | undefined): number {
  if (!pageSize || Number.isNaN(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
}

function normalizeRoomFreebusyItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    start_time: item?.start_time,
    end_time: item?.end_time,
    rsvp_status: item?.rsvp_status,
  };
}

function normalizeRoom(raw: Record<string, any>): RoomSummary {
  const location = typeof raw?.path === 'string' ? raw.path : raw?.location;

  return {
    room_id: raw?.room_id,
    name: raw?.name,
    description: raw?.description,
    display_id: raw?.display_id,
    custom_room_id: raw?.custom_room_id,
    room_level_id: raw?.room_level_id,
    path: raw?.path,
    location,
    capacity: raw?.capacity,
    room_status: raw?.room_status,
    status: raw?.room_status?.status,
    schedule_status: raw?.room_status?.schedule_status,
    disable_start_time: raw?.room_status?.disable_start_time,
    disable_end_time: raw?.room_status?.disable_end_time,
    disable_reason: raw?.room_status?.disable_reason,
    contact_ids: raw?.room_status?.contact_ids,
    device: raw?.device,
  };
}

function createDefaultWorkplaces(): WorkplaceConfig[] {
  return [
    { name: '中建', aliases: ['中建'], matchFields: ['path', 'name', 'description', 'location'] },
    { name: '惠通', aliases: ['惠通'], matchFields: ['path', 'name', 'description', 'location'] },
  ];
}

function readWorkplaces(cfg: FeishuConfig | FeishuAccountConfig | undefined): WorkplaceConfig[] {
  const configured = cfg?.meetingRooms?.workplaces;
  if (!configured || configured.length === 0) {
    return createDefaultWorkplaces();
  }

  return configured.map((item) => ({
    name: item.name,
    aliases: item.aliases ?? [],
    matchFields: item.matchFields ?? ['path', 'name', 'description', 'location'],
  }));
}

function resolveWorkplace(workplaces: WorkplaceConfig[], workplaceName: string | undefined): WorkplaceConfig | undefined {
  if (!workplaceName) return undefined;
  const normalized = workplaceName.trim().toLowerCase();
  if (!normalized) return undefined;

  return workplaces.find((workplace) => {
    if (workplace.name.toLowerCase() === normalized) return true;
    return workplace.aliases.some((alias) => alias.toLowerCase() === normalized);
  });
}

function detectWorkplaceFromText(workplaces: WorkplaceConfig[], text: string | undefined): WorkplaceConfig | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;

  return workplaces.find((workplace) => {
    const candidates = [workplace.name, ...workplace.aliases].map((value) => value.toLowerCase());
    return candidates.some((candidate) => normalized.includes(candidate));
  });
}

function matchesWorkplace(room: RoomSummary, workplace: WorkplaceConfig | undefined): boolean {
  if (!workplace) return true;
  const candidates = [workplace.name, ...workplace.aliases].map((value) => value.toLowerCase());

  return workplace.matchFields.some((field) => {
    const raw = room[field as keyof RoomSummary];
    if (typeof raw !== 'string') return false;
    const text = raw.toLowerCase();
    return candidates.some((candidate) => text.includes(candidate));
  });
}

function matchesQuery(room: RoomSummary, query: string | undefined): boolean {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  const fields = [room.room_id, room.name, room.description, room.location, room.path, room.display_id];
  return fields.some((value) => typeof value === 'string' && value.toLowerCase().includes(normalized));
}

async function listRoomsPage(
  client: ReturnType<ToolContext['toolClient']>,
  pageSize: number,
  pageToken: string | undefined,
): Promise<{ rooms: RoomSummary[]; has_more: boolean; page_token?: string }> {
  const res = await client.invokeByPath<{
    data?: { rooms?: Array<Record<string, unknown>>; has_more?: boolean; page_token?: string };
  }>('feishu_calendar_room.list', '/open-apis/vc/v1/rooms', {
    method: 'GET',
    query: {
      page_size: String(pageSize),
      ...(pageToken ? { page_token: pageToken } : {}),
      user_id_type: OPENAPI_DEFAULT_USER_ID_TYPE,
    },
    as: 'tenant',
  });

  const data = res.data ?? {};
  return {
    rooms: (data.rooms ?? []).map((item) => normalizeRoom(item)).filter((item) => !!item.room_id),
    has_more: data.has_more ?? false,
    page_token: data.page_token,
  };
}

async function scanRooms(
  client: ReturnType<ToolContext['toolClient']>,
  options: {
    query?: string;
    pageSize?: number;
    pageToken?: string;
    workplace?: WorkplaceConfig;
  },
): Promise<{ rooms: RoomSummary[]; has_more: boolean; page_token?: string }> {
  const pageSize = clampPageSize(options.pageSize);

  if (options.query) {
    const res = await client.invokeByPath<{
      data?: { rooms?: Array<Record<string, unknown>>; has_more?: boolean; page_token?: string };
    }>('feishu_calendar_room.search', '/open-apis/vc/v1/rooms/search', {
      method: 'POST',
      query: {
        user_id_type: OPENAPI_DEFAULT_USER_ID_TYPE,
      },
      body: {
        keyword: options.query,
        page_size: pageSize,
        ...(options.pageToken ? { page_token: options.pageToken } : {}),
      },
      as: 'user',
    });

    const data = res.data ?? {};
    const rooms = (data.rooms ?? [])
      .map((item) => normalizeRoom(item))
      .filter((item) => !!item.room_id)
      .filter((item) => matchesWorkplace(item, options.workplace));

    return {
      rooms,
      has_more: data.has_more ?? false,
      page_token: data.page_token,
    };
  }

  const page = await listRoomsPage(client, pageSize, options.pageToken);
  return {
    rooms: page.rooms.filter((room) => matchesWorkplace(room, options.workplace)).filter((room) => matchesQuery(room, options.query)),
    has_more: page.has_more,
    page_token: page.page_token,
  };
}

async function findRoomById(client: ReturnType<ToolContext['toolClient']>, roomId: string): Promise<RoomSummary | null> {
  const normalizedId = roomId.trim();
  if (!normalizedId) return null;

  const res = await client.invokeByPath<{ data?: { room?: Record<string, unknown> } }>(
    'feishu_calendar_room.get',
    `/open-apis/vc/v1/rooms/${encodeURIComponent(normalizedId)}`,
    {
      method: 'GET',
      query: {
        user_id_type: OPENAPI_DEFAULT_USER_ID_TYPE,
      },
      as: 'tenant',
    },
  );

  return normalizeRoom((res.data?.room ?? {}) as Record<string, any>);
}

async function getRoomAvailability(
  client: ReturnType<ToolContext['toolClient']>,
  roomId: string,
  roomName: string | undefined,
  timeMin: string,
  timeMax: string,
): Promise<RoomAvailabilityResult> {
  const res = await client.invokeByPath<{ data?: { freebusy_list?: Array<Record<string, unknown>> } }>(
    'feishu_calendar_room.availability',
    '/open-apis/calendar/v4/freebusy/list',
    {
      method: 'POST',
      query: {
        user_id_type: OPENAPI_DEFAULT_USER_ID_TYPE,
      },
      body: {
        time_min: timeMin,
        time_max: timeMax,
        room_id: roomId,
        include_external_calendar: true,
        only_busy: true,
        need_rsvp_status: true,
      },
      as: 'tenant',
    },
  );

  const freebusyList = (res.data?.freebusy_list ?? []).map((item) => normalizeRoomFreebusyItem(item));
  return {
    room_id: roomId,
    name: roomName,
    is_available: freebusyList.length === 0,
    busy_ranges: freebusyList,
  };
}

export function registerFeishuCalendarRoomTool(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_calendar_room');

  registerTool(
    api,
    {
      name: 'feishu_calendar_room',
      label: 'Feishu Calendar Rooms',
      description:
        '飞书会议室查询工具。用于列出会议室、搜索会议室、查看会议室详情和时间段可用性。Actions: list, get, search, availability, search_available。',
      parameters: FeishuCalendarRoomSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuCalendarRoomParams;

        try {
          const client = toolClient();
          const liveCfg = getResolvedConfig(cfg) as { channels?: { feishu?: FeishuConfig } };
          const workplaces = readWorkplaces(liveCfg.channels?.feishu);
          const explicitWorkplace = 'workplace' in p ? resolveWorkplace(workplaces, p.workplace) : undefined;
          const inferredWorkplace = detectWorkplaceFromText(
            workplaces,
            'query' in p ? p.query : 'room_id' in p ? p.room_id : undefined,
          );
          const workplace = explicitWorkplace ?? inferredWorkplace;

          if ('workplace' in p && p.workplace && !explicitWorkplace) {
            return json({
              error: 'unknown_workplace',
              workplace: p.workplace,
              supported_workplaces: workplaces.map((item) => item.name),
            });
          }

          switch (p.action) {
            case 'list': {
              const result = await scanRooms(client, {
                pageSize: p.page_size,
                pageToken: p.page_token,
                workplace,
              });
              log.info(`room.list: returned ${result.rooms.length} room(s), has_more=${result.has_more}`);
              return json({
                ...result,
                ...(workplace ? { workplace: workplace.name } : {}),
              });
            }
            case 'get': {
              const room = await findRoomById(client, p.room_id);
              if (!room?.room_id) {
                return json({
                  error: `room not found: ${p.room_id}`,
                  room_id: p.room_id,
                });
              }
              log.info(`room.get: resolved room_id=${room.room_id}, room_level_id=${room.room_level_id ?? '-'}`);
              return json({ room });
            }
            case 'search': {
              const result = await scanRooms(client, {
                query: p.query,
                pageSize: p.page_size,
                pageToken: p.page_token,
                workplace,
              });
              log.info(`room.search: query="${p.query}", returned ${result.rooms.length} room(s)`);
              return json({
                ...result,
                ...(workplace ? { workplace: workplace.name } : {}),
              });
            }
            case 'availability': {
              const timeMin = parseTimeToRFC3339(p.time_min);
              const timeMax = parseTimeToRFC3339(p.time_max);
              if (!timeMin || !timeMax) {
                return json({
                  error:
                    "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'.",
                  received_time_min: p.time_min,
                  received_time_max: p.time_max,
                });
              }

              const availability: RoomAvailabilityResult[] = [];
              for (const roomId of p.room_ids) {
                const room = await findRoomById(client, roomId).catch(() => null);
                if (!room?.room_id) {
                  availability.push({
                    room_id: roomId,
                    is_available: false,
                    busy_ranges: [],
                    error: 'room not found',
                  });
                  continue;
                }

                availability.push(await getRoomAvailability(client, room.room_id, room.name, timeMin, timeMax));
              }

              log.info(`room.availability: checked ${availability.length} room(s)`);
              return json({
                availability,
                _debug: {
                  time_min_input: p.time_min,
                  time_max_input: p.time_max,
                  time_min_rfc3339: timeMin,
                  time_max_rfc3339: timeMax,
                },
              });
            }
            case 'search_available': {
              const timeMin = parseTimeToRFC3339(p.time_min);
              const timeMax = parseTimeToRFC3339(p.time_max);
              if (!timeMin || !timeMax) {
                return json({
                  error:
                    "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'.",
                  received_time_min: p.time_min,
                  received_time_max: p.time_max,
                });
              }

              const searched = await scanRooms(client, {
                query: p.query,
                pageSize: p.page_size,
                pageToken: p.page_token,
                workplace,
              });
              const rooms: Array<Record<string, unknown>> = [];
              for (const room of searched.rooms) {
                if (!room.room_id) continue;
                const availability = await getRoomAvailability(client, room.room_id, room.name, timeMin, timeMax);
                if (!availability.is_available) continue;
                rooms.push({
                  ...room,
                  is_available: availability.is_available,
                  busy_ranges: availability.busy_ranges,
                });
              }

              log.info(`room.search_available: query="${p.query ?? ''}", available=${rooms.length}`);
              return json({
                rooms,
                has_more: searched.has_more,
                page_token: searched.page_token,
                ...(workplace ? { workplace: workplace.name } : {}),
                _debug: {
                  time_min_input: p.time_min,
                  time_max_input: p.time_max,
                  time_min_rfc3339: timeMin,
                  time_max_rfc3339: timeMax,
                },
              });
            }
          }
        } catch (err) {
          try {
            // 记录尽可能多的原始错误信息，便于线上定位权限/返回码问题
            log.error(`invoke failed: ${err instanceof Error ? err.message : String(err)}`);
            // 有些 error 对象不可枚举，需要使用 getOwnPropertyNames 安全序列化
            const serialized = typeof err === 'object' && err !== null ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err);
            log.debug(`invoke raw error: ${serialized}`);
          } catch (logErr) {
            log.debug(`failed to serialize invoke error: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
          }

          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_calendar_room' },
  );
}
