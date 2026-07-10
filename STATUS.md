# 当前状态

更新时间：2026-07-10

## 版本

- MCP server / `package.json`：`0.9.0`
- 桥接 Mod / `bridge-mod/ModConfig.json`：`0.9.0`
- 桥接 DLL / `bridge-mod/Dev/Entry.cs`：`0.9.0`

## 工具数量

当前 MCP server 暴露 **66 个工具**。

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
- `package.json`、MCP `serverInfo.version`、`witch_capabilities.serverVersion` 与桥接 Mod 版本同步为 `0.9.0`。
- 默认无鼠标模式仍然启用，`witch_input_mouse` 和底层 `input.mouse` 默认会被拒绝。
