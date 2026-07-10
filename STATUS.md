# 当前状态

更新时间：2026-07-10

## 版本

- MCP server / `package.json`：`0.9.0`
- 桥接 Mod / `bridge-mod/ModConfig.json`：`0.9.0`
- 桥接 DLL / `bridge-mod/Dev/Entry.cs`：`0.9.0`

## 工具数量

当前 MCP server 暴露 **73 个工具**。

请以运行时结果为准：

```powershell
npm run selftest
```

或在 MCP 客户端里调用：

```text
witch_capabilities
```

`STATUS.md` 是人工维护的状态摘要。如果这里的工具数量和 `witch_capabilities.tools.length` 不一致，应优先相信 `witch_capabilities` 的实际返回，并更新本文档。

## 最近补强

- 新增 `witch_event_route_trace`，用于事件/地图路由追踪，输出候选 event id、map node、route 步骤、hook 日志摘要和置信度。
- 新增 `witch_assert_route`、`witch_assert_ui_text`、`witch_assert_event_id`、`witch_assert_forbidden_text`，用于只读回归断言。
- 地图继续/下一地图类操作现在需要执行前后状态指纹变化；底层组件调用 success 但状态没变会返回 `operation_unverified_no_state_change`。
- `includeHidden:false` 会在 MCP 层再次过滤隐藏 UI，奖励/确认/继续类按钮会通过 `intent` 和 `recommendedOperations` 更清晰地暴露。
- 新增 `witch_event_choose_option`、`witch_story_map_snapshot`、`witch_log_tail`、`witch_screenshot`、`witch_map_select_node`。
- `witch_state_summary` / `witch_ui_interact` 支持 `compact` / `fields`，`witch_runtime_component_call` 支持 `waitFor` 状态变化等待。
- 新增 `witch_map_place_card`、`witch_map_fill_path`，新版桥接优先用 `map.place_card` 调用游戏内 `MapItem -> SwapContentIdentity` 放置逻辑，并验证路径槽 `Content` 是否被填入；`witch_execute_operation` 标签选择优先 click/submit 而不是 hover。
- `package.json`、MCP `serverInfo.version`、`witch_capabilities.serverVersion` 与桥接 Mod 版本同步为 `0.9.0`。
- 默认无鼠标模式仍然启用，`witch_input_mouse` 和底层 `input.mouse` 默认会被拒绝。
