# 魔女终末旅途 MCP

这是一个用于 *魔女终末旅途* 的本地 MCP 工具包，让支持 MCP 的客户端可以通过游戏内自动化接口接管游戏操作，而不是盲猜屏幕点击。

它不是 Codex 专用工具。`server.mjs` 是标准 MCP stdio server，理论上可以被 Codex、Claude Desktop、Claude Code、Cursor、Windsurf 或你自己写的 MCP client 启动和调用。Codex 只是当前仓库已经验证过的接入方式之一。

工具包分为两部分：

- `server.mjs`：标准 MCP stdio 服务器，供支持 MCP 的客户端使用。
- `bridge-mod/`：游戏内 `CodexMcpBridge` 模组。它会在本机开启 HTTP 桥接服务，并调用游戏里的 `Witch.UI.Automation.*` 运行时接口。

默认桥接地址是 `http://127.0.0.1:18171`。

默认启用无鼠标模式：MCP 会拒绝 `witch_input_mouse` 和底层 `input.mouse`，自动接管会优先使用游戏合法动作、UI 自动化、场景自动化和运行时调用。

## 安装

1. 把 `bridge-mod/` 复制到游戏 Mod 目录，并把复制后的文件夹命名为 `CodexMcpBridge`。根据你的游戏安装情况，复制到下面一个或两个位置：

   ```powershell
   Copy-Item -Recurse -Force .\bridge-mod "<游戏根目录>\Mods\CodexMcpBridge"
   Copy-Item -Recurse -Force .\bridge-mod "<游戏根目录>\Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge"
   ```

2. 在 MCP 客户端里加入这个 server。Codex 配置示例：

   ```toml
   [mcp_servers.witchJourney]
   command = 'node'
   args = ["<本仓库路径>\\server.mjs"]
   startup_timeout_sec = 20

   [mcp_servers.witchJourney.env]
   WITCH_JOURNEY_BRIDGE_URL = 'http://127.0.0.1:18171'
   WITCH_JOURNEY_GAME_ROOT = '<游戏根目录>'
   WITCH_JOURNEY_NO_MOUSE = 'true'
   ```

   `WITCH_JOURNEY_GAME_ROOT` 用来告诉 MCP server 游戏安装在哪里，例如：

   ```toml
   WITCH_JOURNEY_GAME_ROOT = 'D:\Steam\steamapps\common\Witch''s Apocalyptic Journey'
   ```

   如果你把本仓库放在 `<游戏根目录>\_mcp\witch-journey-mcp`，可以不配置 `WITCH_JOURNEY_GAME_ROOT`，工具会按旧布局自动推断游戏根目录。除此之外，建议始终显式配置这个环境变量，这样仓库 clone 到桌面、文档目录或其他位置也能使用。

   `WITCH_JOURNEY_NO_MOUSE` 默认为 `true`，表示禁止 OS 级鼠标兜底。只有在你明确需要旧的鼠标 fallback 时，才设置为 `0` 或 `false`。

   其他 MCP 客户端通常也会使用同样的核心信息，只是配置文件格式不同：

   ```json
   {
     "command": "node",
     "args": ["<本仓库路径>/server.mjs"],
     "env": {
       "WITCH_JOURNEY_BRIDGE_URL": "http://127.0.0.1:18171",
       "WITCH_JOURNEY_GAME_ROOT": "<游戏根目录>",
       "WITCH_JOURNEY_NO_MOUSE": "true"
     }
   }
   ```

3. 重启你的 MCP 客户端，让新的 server 配置生效。

4. 重启游戏。

5. 检查游戏内桥是否可用：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\check-bridge.ps1
   ```

## 工具能力

当前 MCP server 暴露 49 个工具，覆盖：

- 桥接状态检查、等待、重启编排
- 本地运行时诊断、Mod 文件检查、桥文件新旧检查
- 接管前准备、readiness 检查、完整接管审计
- UI 快照、UI 点击和交互
- 场景对象快照、场景交互、raycast
- 截图、窗口聚焦、本地 OS 输入兜底
- 游戏合法动作、战斗快照、出牌、合法动作匹配、有边界的自动驾驶
- 运行时类型/对象检查、组件成员枚举、组件方法 dry-run/确认调用、组件属性 dry-run/确认写入、静态运行时方法调用
- 观察-规划-执行辅助，例如 `witch_control_map`、`witch_state_summary`、`witch_plan_next`、`witch_execute_plan`、`witch_takeover_step`、`witch_takeover_drive`
- 无鼠标能力审计和运行时覆盖矩阵，例如 `witch_no_mouse_audit`、`witch_no_mouse_coverage`

建议对接管循环、组件调用、组件写入、静态运行时调用先使用 dry-run，确认目标和参数后再执行真实动作。

## 无鼠标模式

MCP 默认不使用 OS 鼠标。也就是说：

- `witch_perform_action_match` / `witch_auto_step` / `witch_auto_drive` 走游戏自己的合法动作层。
- `witch_ui_interact` 和 `witch_ui_click_label` 走游戏内 UI 自动化，即使 action 名叫 `click`，也不是移动 Windows 鼠标。
- `witch_scene_interact` 走游戏内场景自动化，也不是移动 Windows 鼠标。
- `witch_battle_snapshot` 可以观察战斗手牌和可选目标，`witch_play_card` 可以按卡牌/目标参数出牌，不需要移动鼠标去点卡牌。
- `witch_input_mouse` 和 `witch_bridge_command` 里的 `input.mouse` 默认返回 `mouse_forbidden`，不会触发 `SetCursorPos` 或 `mouse_event`。

如果确实要临时恢复 OS 鼠标兜底，可以设置环境变量 `WITCH_JOURNEY_NO_MOUSE=0`，或单次调用 `witch_input_mouse` 时传 `noMouse:false`。不建议把它作为自动接管路径。

## 验证

不启动真实游戏桥时，可以运行本地协议测试：

```powershell
npm run selftest
npm run calltest
npm run orchestration-test
npm run no-mouse-test
npm run e2e-fake
```

安装桥接 Mod 并重启游戏后，可以运行真实游戏验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\wait-and-verify.ps1 -TimeoutSec 180 -IntervalSec 2
```

如果希望脚本自动重启游戏、等待桥上线、执行审计和完整验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\restart-and-verify.ps1 -ConfirmRestart RESTART_WITCH_GAME
```

`restart-and-verify.ps1` 会关闭并重启游戏。为了避免误操作，它必须传入 `-ConfirmRestart RESTART_WITCH_GAME` 才会执行。

## 构建桥接 DLL

仓库已经包含 `bridge-mod/Scripts/Entry.dll`。如果修改了 `bridge-mod/Dev/Entry.cs` 并希望重新构建 DLL，需要把桥源码复制或同步到游戏 Mod 目录，然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\compile-bridge.ps1
```

构建脚本会引用已安装游戏里的 managed assemblies，因此默认要求仓库位于游戏根目录下，或者你自行调整脚本里的路径。

如果仓库不在游戏根目录下，先设置 `WITCH_JOURNEY_GAME_ROOT` 再运行构建脚本：

```powershell
$env:WITCH_JOURNEY_GAME_ROOT = "<游戏根目录>"
powershell -ExecutionPolicy Bypass -File .\tools\compile-bridge.ps1
```

## 安全设计

- 桥接服务只绑定本机 localhost。
- 重启游戏进程需要显式确认 token。
- 组件方法调用和组件属性写入默认是 dry-run，真实执行需要确认字符串。
- 动作策略可以按合法动作 id、kind、label 做 allow/deny，避免自动执行未审核动作。
