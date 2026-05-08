---
name: feishu-meeting-room-booking
description: |
  飞书会议室预约技能。用于完成会议室搜索、可用性查询、创建带会议室资源的日程，并处理职场确认。
---

# 飞书会议室预约

## 执行前必读

- 时区固定：`Asia/Shanghai`（UTC+8）
- 时间格式：ISO 8601 / RFC 3339（带时区），例如 `2026-04-28T15:00:00+08:00`
- 会议室 ID 格式：`omm_...`
- 用户 open_id 格式：`ou_...`
- 创建日程时强烈建议传 `user_open_id`
- 用户忙闲只用 `feishu_calendar_freebusy`
- 会议室忙闲只用 `feishu_calendar_room.availability`

## 工具索引

| 用户意图 | 工具 | action | 必填参数 | 注意事项 |
|---------|------|--------|---------|---------|
| 列出会议室 | `feishu_calendar_room` | `list` | `action` | 可获取所有会议室的 room_id |
| 查会议室详情 | `feishu_calendar_room` | `get` | `room_id` | 可确认会议室状态 |
| 搜索会议室 | `feishu_calendar_room` | `search` | `query` | 支持 workplace 过滤 |
| 查会议室可用性 | `feishu_calendar_room` | `availability` | `time_min`, `time_max`, `room_ids` | ⚠️ **已知 bug**：只支持单个 room_id，传入数组会导致解析错误 |
| 搜索可用会议室 | `feishu_calendar_room` | `search_available` | `time_min`, `time_max` | 推荐使用，支持多条件过滤 |
| 查用户忙闲 | `feishu_calendar_freebusy` | `list` | `time_min`, `time_max`, `user_ids` | 支持批量查询 |
| 创建带会议室的日程 | `feishu_calendar_event` | `create` | `summary`, `start_time`, `end_time` | 同时添加人员和会议室资源 |
| 添加参会人/资源 | `feishu_calendar_event_attendee` | `create` | `calendar_id`, `event_id`, `attendees` | 用于补充添加参会人员和会议室资源 |
| 回读会议室预约状态 | `feishu_calendar_event_attendee` | `list` | `calendar_id`, `event_id` | 检查 rsvp_status |

## 推荐调用顺序

### 场景 1：用户不知道 room_id

1. 如果用户话术里没有明确职场，且存在多个可混淆职场，先调用 `feishu_ask_user_question` 确认职场。
2. 用 `feishu_calendar_room.search` 查候选会议室。
3. 用 `feishu_calendar_room.availability` 或 `search_available` 过滤可用房间。
4. 选中房间后，用 `feishu_calendar_event.create` 创建事件，**同时传入所有参会人员（type=user）和会议室资源（type=resource）**。
5. **必须回读确认**：调用 `feishu_calendar_event_attendee.list` 检查：
   - 参会人员是否都已添加（user 类型）
   - 会议室资源是否已添加（resource 类型，rsvp_status 应为 accepted 或 needs_action）

### 场景 2：用户已经知道 room_id

1. 直接用 `feishu_calendar_room.availability` 检查时间段。
2. 如果可用，再调用 `feishu_calendar_event.create`，**同时传入所有参会人员和会议室资源**。
3. **必须回读确认**：检查 `resource_attendees_count` 和参会人员列表。

### 场景 3：用户指定了职场

- 如果话术中包含 `中建` 或 `惠通`，优先把该词作为 `workplace` 传给 `feishu_calendar_room.search` / `search_available`。
- 如果未显式传 `workplace`，但查询词中包含这些关键字，工具也会自动收敛。

### 场景 4：创建后会议室或参会人员未添加成功

**关键检查点**：创建日程后，必须调用 `feishu_calendar_event_attendee.list` 检查：

**第一步：检查参会人员是否添加成功**
- 遍历返回的 `attendees` 数组，确认所有预期的 user 类型参会人员都存在
- 如果缺少参会人员，使用 `feishu_calendar_event_attendee.create` 补充添加（type=user）

**第二步：检查会议室资源是否添加成功**
- **`resource_attendees_count > 0`**：会议室资源已成功添加 ✅
- **`resource_attendees_count = 0`**：会议室资源添加失败 ❌，需要执行：
  1. 使用 `feishu_calendar_event_attendee.create` 重新添加会议室资源（type=resource）
  2. 再次回读确认 `resource_attendees_count > 0`

**第三步：检查预约状态**
- **`rsvp_status = "accepted"`**：预约成功 ✅
- **`rsvp_status = "needs_action"`**：预约处理中，告知用户"正在确认"
- **`rsvp_status = "declined"`**：预约失败 ❌，告知用户并建议尝试其他会议室

## 重要约束

### 1. 创建日程时必须同时添加所有参会人员和会议室

**禁止**：先创建日程，再逐个添加参会人员（容易遗漏）

**正确做法**：在 `feishu_calendar_event.create` 的 `attendees` 参数中一次性传入：
- 所有 user 类型的参会人员
- 所有 resource 类型的会议室资源

示例：
```json
{
  "action": "create",
  "summary": "项目沟通会",
  "start_time": "2026-04-28T15:00:00+08:00",
  "end_time": "2026-04-28T15:30:00+08:00",
  "user_open_id": "ou_xxx",
  "attendees": [
    { "type": "user", "id": "ou_参会人1" },
    { "type": "user", "id": "ou_参会人2" },
    { "type": "resource", "id": "omm_会议室id" }
  ]
}
```

### 2. 创建后必须回读确认

**禁止跳过回读确认就告知用户"预约成功"**

必须调用 `feishu_calendar_event_attendee.list` 确认：
1. 所有预期的参会人员都存在于 `attendees` 列表中
2. 会议室资源存在于 `resource_attendees` 中（如果有）
3. `rsvp_status` 状态正常

### 3. 会议室预约是异步确认

创建带会议室资源的日程后：
- `resource_booking_status = "success"` 表示已进入资源预约链路
- `resource_attendees[].rsvp_status = "needs_action"` 表示预约处理中
- `resource_attendees[].booking_state = "pending"` 表示不要判失败

### 4. `user_open_id` 很重要

创建日程时如果没有传 `user_open_id`：
- 日程可能只停留在应用上下文
- 用户体验会变差
- 后续排查更困难

默认应传当前发起用户的 `SenderId`。

### 5. 改期和取消的处理原则

- 改期前先做会议室新时间段可用性检查，再执行 `feishu_calendar_event.patch`
- 改期后用 `feishu_calendar_event_attendee.list` 回读资源状态
- 取消使用 `feishu_calendar_event.delete`
- 不做自动回滚

## 示例

### 搜索今天下午可用会议室

```json
{
  "action": "search_available",
  "time_min": "2026-04-28T15:00:00+08:00",
  "time_max": "2026-04-28T16:00:00+08:00",
  "query": "海王星",
  "workplace": "中建"
}
```

### 创建带会议室和参会人员的日程

```json
{
  "action": "create",
  "summary": "项目沟通会",
  "start_time": "2026-04-28T15:00:00+08:00",
  "end_time": "2026-04-28T15:30:00+08:00",
  "user_open_id": "ou_xxx",
  "attendees": [
    { "type": "user", "id": "ou_参会人1" },
    { "type": "user", "id": "ou_参会人2" },
    { "type": "resource", "id": "omm_xxx" }
  ]
}
```

### 回读确认参会人员和会议室

```json
{
  "action": "list",
  "calendar_id": "feishu.cn_xxx@group.calendar.feishu.cn",
  "event_id": "xxx"
}
```

## 常见错误

| 现象 | 原因 | 处理方式 |
|------|------|---------|
| `need_user_authorization` | 用户 OAuth 未完成 | 先完成用户授权，再调用用户态工具 |
| `room not found` | `room_id` 无效或租户不可见 | 先用 `search` / `list` 重新确认会议室 |
| `unknown_workplace` | 传入了未配置的职场名 | 改用配置内职场，或先确认用户是否指的是 `中建` / `惠通` |
| 参会人员只有自己 | 创建时未正确传入 attendees | 使用 `feishu_calendar_event_attendee.create` 补充添加参会人员 |
| 会议室显示 `needs_action` | 异步确认中 | 不要直接判失败，告知用户"正在确认" |
| `resource_attendees_count = 0` | 会议室资源添加失败 | 使用 `feishu_calendar_event_attendee.create` 重新添加会议室资源 |
| `rsvp_status = "declined"` | 会议室拒绝（可能是权限问题） | 告知用户预约失败，尝试其他会议室 |
| 创建事件成功但房间失败 | 资源添加链路部分成功 | 读取 `resource_attendees` 和 `resource_booking_status` 判断 |
| `availability` 传入数组 room_ids | 已知 bug，解析错误 | 只传入单个 room_id，或使用 `search_available` |