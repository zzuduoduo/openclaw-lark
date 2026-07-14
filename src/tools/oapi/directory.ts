/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_directory tool -- 读取飞书通讯录与群聊列表
 *
 * 用于后台管理面板的「通知范围」选择：
 *  - 用户：有搜索词时拉取通讯录并客户端按姓名/手机/邮箱过滤；无搜索词时
 *    直接浏览通讯录列表（contact.user.list，scope: contact:contact.base:readonly）。
 *  - 群聊：调用 im/v1/chats（scope: im:chat:read）。
 *
 * 账号解析：本工具统一使用 TAT（应用身份）调用通讯录/群聊接口，不依赖
 * 用户 token（UAT）。后台管理面板经 RPC 调用本工具时，LarkTicket 的
 * accountId 会回退为 "default"（未配置），若直接走 `createToolClient`
 * 会抛 "Feishu account default is not configured"。因此这里自行解析账号：
 * 优先从 config 的 `bindings` 读取 `channel: feishu` 对应的 `account_id`
 * （本仓库为 `work`），回退到第一个启用的飞书账号；再用
 * `getResolvedConfig`（live config，凭据已解析）+ `LarkClient.fromAccount`
 * 构建 SDK，确保 tenant access token 正确注入。
 *
 * 注意：本工具统一使用 TAT（应用身份）调用，不依赖用户 token（UAT）。
 * 因为后台调用场景没有用户上下文，而通讯录/群聊列表所需的 scope 均为
 * 应用权限（app-permission），使用应用身份即可访问。
 */

import type { ClawdbotConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { Type } from '@sinclair/typebox';
import { getEnabledLarkAccounts, getLarkAccount } from '../../core/accounts';
import { LarkClient, getResolvedConfig } from '../../core/lark-client';
import { StringEnum, createToolContext, json, registerTool } from './helpers';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DirectorySchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: '搜索关键词（匹配姓名 / 手机 / 邮箱 / open_id / 群名），可选',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: '返回数量上限（默认 50，最大 10000）',
      minimum: 1,
      maximum: 10000,
    }),
  ),
  kind: Type.Optional(
    StringEnum(['all', 'user', 'group'], {
      description: '返回类型：all=用户+群聊，user=仅用户，group=仅群聊（默认 all）',
    }),
  ),
});

// ---------------------------------------------------------------------------
// Params / result types
// ---------------------------------------------------------------------------

interface DirectoryParams {
  query?: string;
  limit?: number;
  kind?: 'all' | 'user' | 'group';
}

interface DirectoryUser {
  kind: 'user';
  id: string;
  name?: string;
}

interface DirectoryGroup {
  kind: 'group';
  id: string;
  name?: string;
}

/** 部门节点信息，用于前端渲染组织架构树 */
interface DepartmentNode {
  id: string;           // open_department_id ('0' 表示根部门)
  name?: string;
  parent_id?: string;   // 父部门 open_department_id
  user_count: number;   // 该部门直属用户数（去重前）
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 大小写不敏感的子串匹配（id + 可选 name）。 */
function matchesQuery(id: string, name: string | undefined, query: string): boolean {
  if (!query) return true;
  return (
    id.toLowerCase().includes(query) || (name?.toLowerCase().includes(query) ?? false)
  );
}

/**
 * 解析本工具应使用的飞书账号 ID。
 *
 * 后台管理面板经 RPC 调用本工具时，没有用户上下文，LarkTicket 的
 * accountId 会回退为 "default"（该账号在 config 中未配置）。若直接交给
 * `createToolClient` 解析，会因优先使用 ticket 的 accountId 而抛
 * "Feishu account default is not configured"。
 *
 * 因此这里自行解析：
 *  1. 优先读取 config 的 `bindings` 里 `match.channel === 'feishu'` 对应的
 *     `account_id`（本仓库为 `work`）；
 *  2. 否则回退到第一个启用的飞书账号；
 *  3. 最后兜底为 `work`。
 */
function resolveFeishuAccountId(cfg: ClawdbotConfig): string {
  // 用 live config，确保凭据已解析（SecretRef → 字符串）。
  const resolveConfig = getResolvedConfig(cfg);

  const feishuAccountIds = new Set(getEnabledLarkAccounts(resolveConfig).map((a) => a.accountId));

  const anyCfg = resolveConfig as unknown as {
    bindings?: Array<{
      channel?: string;
      account_id?: string;
      match?: { channel?: string; account_id?: string };
    }>;
  };
  const bindings = Array.isArray(anyCfg.bindings) ? anyCfg.bindings : [];
  for (const b of bindings) {
    const channel = b?.match?.channel ?? b?.channel;
    const accountId = b?.match?.account_id ?? b?.account_id;
    if (channel === 'feishu' && accountId && feishuAccountIds.has(accountId)) {
      return accountId;
    }
  }

  // 回退：第一个启用的飞书账号
  const enabled = getEnabledLarkAccounts(resolveConfig);
  if (enabled.length > 0) return enabled[0].accountId;

  // 最后兜底
  return 'work';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuDirectoryTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { log } = createToolContext(api, 'feishu_directory');

  return registerTool(
    api,
    {
      name: 'feishu_directory',
      label: 'Feishu: Directory (Contacts & Chats)',
      description:
        '读取飞书通讯录（用户）与机器人可见的群聊列表，用于后台选择通知范围。' +
        '返回 users（open_id + 姓名）与 groups（chat_id + 群名）。',
      parameters: DirectorySchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as DirectoryParams;
        const kind = p.kind || 'all';
        const limit = Math.min(Math.max(p.limit ?? 50, 1), 10000);
        const query = p.query?.trim().toLowerCase() || undefined;

        // 自行解析飞书账号（绕过 ticket 的 "default" 回退），并用
        // getResolvedConfig（live config，凭据已解析）+ LarkClient.fromAccount
        // 构建 SDK，确保 tenant access token 正确注入（TAT 应用身份）。
        const accountId = resolveFeishuAccountId(cfg);
        const resolveConfig = getResolvedConfig(cfg);
        const account = getLarkAccount(resolveConfig, accountId);
        if (!account.configured) {
          throw new Error(
            `Feishu account "${accountId}" is not configured (missing appId or appSecret). ` +
              `Please check channels.feishu.accounts.${accountId} in your config.`,
          );
        }
        const sdk: Lark.Client = LarkClient.fromAccount(account).sdk;

        try {
          const result = await listFeishuUsers(sdk, limit, query, log);
          const users: DirectoryUser[] =
            kind === 'group' ? [] : result.users;

          // 群聊（im/v1/chats）依赖「机器人能力」是否激活，若未激活飞书会返回
          // code 232025 "Bot ability is not activated"，属于飞书侧配置项，与用户
          // 搜索无关。因此将 groups 的失败隔离：即便拉群失败，已成功的 users
          // （如按姓名搜到的马世平）仍要正常返回，避免一处非核心功能拖垮整个工具。
          let groups: DirectoryGroup[] = [];
          let groupsError: string | undefined;
          if (kind !== 'user') {
            try {
              groups = await listFeishuGroups(sdk, limit, query);
            } catch (err) {
              groupsError = err instanceof Error ? err.message : String(err);
              log.warn(
                `directory: groups fetch failed (users still returned): ${groupsError}`,
              );
            }
          }

          log.info(
            `directory: account=${accountId}, kind=${kind}, users=${users.length}, groups=${groups.length}${
              groupsError ? ` (groups_error: ${groupsError})` : ''
            }`,
          );

          const response: Record<string, unknown> = { users, groups };
          // 始终返回部门树数据（前端加载时需要），即使 kind=group 也返回
          // 以便缓存复用。
          response.departments = result.departments;
          response.dept_users = result.deptUsers;
          if (groupsError) response.groups_error = groupsError;
          return json(response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`directory failed: ${message}`);
          // 返回结构化错误，便于后台 UI 优雅降级（而非抛 RPC 异常）
          return json({ users: [], groups: [], error: message });
        }
      },
    },
    { name: 'feishu_directory' },
  );
}

// ---------------------------------------------------------------------------
// 用户：通讯录（contact/v3，应用身份 TAT，返回真实 open_id）
//
// 关键约束：飞书**没有**面向应用身份（tenant_access_token）的姓名模糊搜索
// 接口——
//  - contact/v3 里并不存在 `users/search`（旧代码请求它会被网关拒为 HTTP 400）；
//  - SDK 的 contact.user.list 实际是「门禁记录」接口（from/to/device_id/
//    access_record_id），并非通讯录用户列表，不能用于枚举用户；
//  - `search/v1/user` 支持姓名模糊搜索，但**仅支持用户身份（user_access_token）**。
// 后台管理面板无用户上下文，只能用应用身份，因此这里用「遍历部门 + 客户端
// 过滤」的方式枚举通讯录用户。
//
// 性能：先一次性拿到全部部门 ID（department.children(0, fetch_child=true)，
// 一次分页调用即可递归得到所有子部门），再**并发**（CONCURRENCY）对每个部门
// 调 find_by_department 拉用户。相比逐个串行遍历 160 个部门（~12 秒），并发后
// 约 1~2 秒即可。全程走 SDK 的 tenant_access_token（由 LarkClient 自动管理），
// 与 groups 的 im.chat.list 一致。
// ---------------------------------------------------------------------------

/**
 * 列出用户：通过 contact/v3 真实接口枚举通讯录用户，返回**真实 open_id**，
 * 可直接用于 im.message.create 主动推送。
 *
 * 返回值包含：
 *  - users: 扁平用户列表（向后兼容）
 *  - departments: 部门节点列表（含名称、父子关系、直属用户数）
 *  - deptUsers: 部门 ID -> 用户列表的映射（用于前端渲染树）
 *
 * 步骤：
 *  1. department.children(0, fetch_child=true) 一次性递归拿到全部子部门信息
 *  2. 并发（DIRECTORY_CONCURRENCY）对每个部门调 find_by_department 拉直属用户，
 *     按 open_id 去重汇总；有 query 时客户端按姓名 / open_id 过滤。
 *  3. 拿够 limit 即停（搜索模式会继续扫更多部门以命中目标）。
 */
const DIRECTORY_CONCURRENCY = 20;

interface ListFeishuUsersResult {
  users: DirectoryUser[];
  departments: DepartmentNode[];
  deptUsers: Record<string, DirectoryUser[]>;
}

async function listFeishuUsers(
  sdk: Lark.Client,
  limit: number,
  query: string | undefined,
  log?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<ListFeishuUsersResult> {
  const collected = new Map<string, DirectoryUser>();
  const deptUsers: Record<string, DirectoryUser[]> = {};

  // 1. 全部部门信息：根部门 + 递归子部门（一次分页调用拿到全部）。
  const departments = await collectDepartmentNodes(sdk, log);

  // 2. 并发拉取各部门用户（并发上限 DIRECTORY_CONCURRENCY）。
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < departments.length) {
      const deptNode = departments[cursor++];
      if (collected.size >= limit) return;
      const deptUsersArr = await collectDepartmentUsers(
        sdk,
        deptNode.id,
        query,
        limit,
        collected,
        log,
      );
      if (deptUsersArr.length > 0) {
        deptUsers[deptNode.id] = deptUsersArr;
        deptNode.user_count = deptUsersArr.length;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DIRECTORY_CONCURRENCY, departments.length) }, worker),
  );

  const users = Array.from(collected.values()).slice(0, limit);
  log?.info(
    `directory users: departments=${departments.length}, matched=${users.length}${
      query ? ` query=${query}` : ''
    }`,
  );
  return { users, departments, deptUsers };
}

/** 递归拉取根部门下的全部部门信息（含名称、父子关系）。 */
async function collectDepartmentNodes(
  sdk: Lark.Client,
  log?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<DepartmentNode[]> {
  const nodes: DepartmentNode[] = [{ id: '0', name: '根部门', parent_id: undefined, user_count: 0 }];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    try {
      resp = await sdk.contact.department.children({
        path: { department_id: '0' },
        params: {
          fetch_child: true,
          department_id_type: 'open_department_id',
          page_size: 50,
          page_token: pageToken,
        },
      });
    } catch (err) {
      log?.warn(`department.children failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    if (resp?.code !== 0 || !resp?.data?.items) {
      log?.warn(`department.children failed: code=${resp?.code ?? 'unknown'} msg=${resp?.msg ?? ''}`);
      break;
    }

    for (const dept of resp.data.items) {
      const id = dept.open_department_id;
      if (id) {
        nodes.push({
          id,
          name: dept.name || undefined,
          parent_id: dept.parent_department_id || undefined,
          user_count: 0,
        });
      }
    }

    pageToken = resp.data.page_token;
    pages += 1;
  } while (pageToken && pages < 100);

  return nodes;
}

/**
 * 带重试的 find_by_department：高并发下飞书可能限流（HTTP 429 / 超时），
 * 这里最多重试 3 次、指数退避，避免单部门拉取失败导致搜索漏人。
 */
async function findByDepartmentWithRetry(
  sdk: Lark.Client,
  departmentId: string,
  departmentIdType: 'department_id' | 'open_department_id',
  pageToken: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sdk.contact.user.findByDepartment({
        params: {
          department_id: departmentId,
          department_id_type: departmentIdType,
          user_id_type: 'open_id',
          page_size: 50,
          page_token: pageToken,
        },
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 拉取指定部门的直属用户（分页），过滤后写入 collected（按 open_id 去重），
 *  同时返回本部门匹配的用户列表（用于构建部门-用户树）。
 *
 * 部门 ID 类型策略：
 *  - 根部门 '0'：优先尝试 'department_id'，失败后 fallback 到 'open_department_id'
 *  - 子部门：统一使用 'open_department_id'
 */
async function collectDepartmentUsers(
  sdk: Lark.Client,
  departmentId: string,
  query: string | undefined,
  limit: number,
  collected: Map<string, DirectoryUser>,
  log?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<DirectoryUser[]> {
  // 确定要尝试的 department_id_type 列表
  const idTypes: Array<'department_id' | 'open_department_id'> =
    departmentId === '0'
      ? ['department_id', 'open_department_id']  // 根部门：先试 department_id，再 fallback
      : ['open_department_id'];                   // 子部门：只用 open_department_id

  // 逐个尝试 idType，直到有一个成功
  for (const departmentIdType of idTypes) {
    const result = await collectDepartmentUsersWithType(
      sdk, departmentId, departmentIdType, query, limit, collected, log,
    );
    if (result.length > 0 || departmentIdType === idTypes[idTypes.length - 1]) {
      return result;  // 有数据 或 已是最后一个 fallback，直接返回
    }
    // 当前 idType 无数据且还有 fallback，继续尝试下一个
    log?.warn(
      `find_by_department(${departmentId}) type=${departmentIdType} returned empty, trying next type`,
    );
  }
  return [];
}

/** 用指定的 department_id_type 拉取单个部门的用户（内部实现，含分页 + 重试）。 */
async function collectDepartmentUsersWithType(
  sdk: Lark.Client,
  departmentId: string,
  departmentIdType: 'department_id' | 'open_department_id',
  query: string | undefined,
  limit: number,
  collected: Map<string, DirectoryUser>,
  log?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<DirectoryUser[]> {
  let pageToken: string | undefined;
  let pages = 0;
  const deptLocalUsers: DirectoryUser[] = [];

  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    try {
      resp = await findByDepartmentWithRetry(sdk, departmentId, departmentIdType, pageToken);
    } catch (err) {
      log?.warn(
        `find_by_department(${departmentId}) type=${departmentIdType} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      break;
    }

    if (resp?.code !== 0 || !resp?.data?.items) {
      log?.warn(
        `find_by_department(${departmentId}) type=${departmentIdType} failed: code=${
          resp?.code ?? 'unknown'
        } msg=${resp?.msg ?? ''}`,
      );
      break;
    }

    for (const u of resp.data.items) {
      const id = u.open_id;
      if (!id || collected.has(id)) continue;
      const name = u.name;
      if (query && !matchesQuery(id, name, query)) continue;
      const user: DirectoryUser = { kind: 'user', id, name: name || undefined };
      collected.set(id, user);
      deptLocalUsers.push(user);
      if (collected.size >= limit) return deptLocalUsers;
    }

    pageToken = resp.data.page_token;
    pages += 1;
  } while (pageToken && pages < 50);

  return deptLocalUsers;
}

// ---------------------------------------------------------------------------
// 群聊：im/v1/chats
// ---------------------------------------------------------------------------

async function listFeishuGroups(
  sdk: Lark.Client,
  limit: number,
  query: string | undefined,
): Promise<DirectoryGroup[]> {
  const groups: DirectoryGroup[] = [];
  const maxFetch = query ? 500 : limit;
  let pageToken: string | undefined;

  do {
    const remaining = maxFetch - groups.length;
    const response = await sdk.im.chat.list({
      params: {
        page_size: Math.min(remaining, 100),
        page_token: pageToken,
      },
    });

    if (response.code !== 0 || !response.data?.items) break;

    for (const chat of response.data.items) {
      if (chat.chat_id && (!query || matchesQuery(chat.chat_id, chat.name, query))) {
        groups.push({ kind: 'group', id: chat.chat_id, name: chat.name || undefined });
      }
      if (groups.length >= maxFetch) break;
    }

    pageToken = response.data?.page_token;
  } while (pageToken && groups.length < maxFetch);

  return groups.slice(0, limit);
}
