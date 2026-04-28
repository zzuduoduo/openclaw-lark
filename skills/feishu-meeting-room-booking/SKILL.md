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

| 用户意图 | 工具 | action | 必填参数 |
|---------|------|--------|---------|
| 列出会议室 | `feishu_calendar_room` | `list` | `action` |
| 查会议室详情 | `feishu_calendar_room` | `get` | `room_id` |
| 搜索会议室 | `feishu_calendar_room` | `search` | `query` |
| 查会议室可用性 | `feishu_calendar_room` | `availability` | `time_min`, `time_max`, `room_ids` |
| 搜索可用会议室 | `feishu_calendar_room` | `search_available` | `time_min`, `time_max` |
| 查用户忙闲 | `feishu_calendar_freebusy` | `list` | `time_min`, `time_max`, `user_ids` |
| 创建带会议室的日程 | `feishu_calendar_event` | `create` | `summary`, `start_time`, `end_time` |
| 回读会议室预约状态 | `feishu_calendar_event_attendee` | `list` | `calendar_id`, `event_id` |

## 推荐调用顺序

### 场景 1：用户不知道 room_id

1. 如果用户话术里没有明确职场，且存在多个可混淆职场，先调用 `feishu_ask_user_question` 确认职场。
2. 用 `feishu_calendar_room.search` 查候选会议室。
3. 用 `feishu_calendar_room.availability` 或 `search_available` 过滤可用房间。
4. 选中房间后，用 `feishu_calendar_event.create` 创建事件。
5. 如果返回 `resource_attendees[].booking_state = "pending"`，明确告诉用户会议室仍在异步确认。

### 场景 2：用户已经知道 room_id

1. 直接用 `feishu_calendar_room.availability` 检查时间段。
2. 如果可用，再调用 `feishu_calendar_event.create`。

### 场景 3：用户指定了职场

- 如果话术中包含 `中建` 或 `惠通`，优先把该词作为 `workplace` 传给 `feishu_calendar_room.search` / `search_available`。
- 如果未显式传 `workplace`，但查询词中包含这些关键字，工具也会自动收敛。

## 重要约束

### 1. 会议室预约是异步确认

创建带会议室资源的日程后：

- `resource_booking_status = "success"` 表示已进入资源预约链路
- `resource_attendees[].rsvp_status = "needs_action"` 表示预约处理中
- `resource_attendees[].booking_state = "pending"` 表示不要判失败

### 2. `user_open_id` 很重要

创建日程时如果没有传 `user_open_id`：

- 日程可能只停留在应用上下文
- 用户体验会变差
- 后续排查更困难

默认应传当前发起用户的 `SenderId`。

### 3. 改期和取消的处理原则

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

### 创建带会议室的事件

```json
{
  "action": "create",
  "summary": "项目沟通会",
  "start_time": "2026-04-28T15:00:00+08:00",
  "end_time": "2026-04-28T15:30:00+08:00",
  "user_open_id": "ou_xxx",
  "attendees": [
    { "type": "resource", "id": "omm_xxx" }
  ]
}
```

## 常见错误

| 现象 | 原因 | 处理方式 |
|------|------|---------|
| `need_user_authorization` | 用户 OAuth 未完成 | 先完成用户授权，再调用用户态工具 |
| `room not found` | `room_id` 无效或租户不可见 | 先用 `search` / `list` 重新确认会议室 |
| `unknown_workplace` | 传入了未配置的职场名 | 改用配置内职场，或先确认用户是否指的是 `中建` / `惠通` |
| 会议室显示 `needs_action` | 异步确认中 | 不要直接判失败，必要时后续回读 |
| 创建事件成功但房间失败 | 资源添加链路部分成功 | 读取 `resource_attendees` 和 `resource_booking_status` 判断 |
