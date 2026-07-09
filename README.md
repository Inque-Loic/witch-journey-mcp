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

当前 MCP server 暴露 51 个工具，覆盖：

- 桥接状态检查、等待、重启编排
- 本地运行时诊断、Mod 文件检查、桥文件新旧检查
- 接管前准备、readiness 检查、完整接管审计
- UI 快照、UI 点击和交互
- 场景对象快照、场景交互、raycast
- 截图、窗口聚焦、本地 OS 输入兜底
- 游戏合法动作、战斗快照、出牌、合法动作匹配、有边界的自动驾驶
- 运行时类型/对象检查、组件成员枚举、组件方法 dry-run/确认调用、组件属性 dry-run/确认写入、静态运行时方法调用
- 观察-规划-执行辅助，例如 `witch_control_map`、`witch_execute_operation`、`witch_state_summary`、`witch_plan_next`、`witch_execute_plan`、`witch_takeover_step`、`witch_takeover_drive`
- 无鼠标能力审计、运行时覆盖矩阵、跨状态证据记录、操作级探针、ready 操作批量采证、证据驱动循环、证据机会监听、确认式重启后采证、证据缺口计划和严格完成度审计，例如 `witch_no_mouse_audit`、`witch_no_mouse_coverage`、`witch_no_mouse_record_evidence`、`witch_no_mouse_probe_operation`、`witch_no_mouse_collect_ready_evidence`、`witch_no_mouse_evidence_drive`、`witch_no_mouse_watch_evidence`、`witch_no_mouse_restart_collect_audit`、`witch_no_mouse_evidence_plan`、`witch_no_mouse_completion_audit`

建议对接管循环、组件调用、组件写入、静态运行时调用先使用 dry-run，确认目标和参数后再执行真实动作。

如果客户端想用统一入口接管当前可见操作，推荐先调用 `witch_control_map` 获取当前合法动作、UI、场景和战斗操作列表，再用 `witch_execute_operation` 按 `operationId`、`family/action`、`label` 或 `index` 执行对应的 no-mouse MCP 调用。`witch_execute_operation` 默认 `dryRun:true`，只有显式传 `dryRun:false` 才会真实执行，并且会拒绝任何映射到 OS 鼠标的操作。

## 无鼠标模式

MCP 默认不使用 OS 鼠标。也就是说：

- `witch_perform_action_match` / `witch_auto_step` / `witch_auto_drive` 走游戏自己的合法动作层。
- `witch_ui_interact` 和 `witch_ui_click_label` 走游戏内 UI 自动化，即使 action 名叫 `click`，也不是移动 Windows 鼠标。
- `witch_scene_interact` 走游戏内场景自动化，也不是移动 Windows 鼠标。
- `witch_battle_snapshot` 可以观察战斗手牌和可选目标，`witch_play_card` 可以按卡牌/目标参数出牌，不需要移动鼠标去点卡牌。
- `witch_input_mouse` 和 `witch_bridge_command` 里的 `input.mouse` 默认返回 `mouse_forbidden`，不会触发 `SetCursorPos` 或 `mouse_event`。

如果确实要临时恢复 OS 鼠标兜底，可以设置环境变量 `WITCH_JOURNEY_NO_MOUSE=0`，或单次调用 `witch_input_mouse` 时传 `noMouse:false`。不建议把它作为自动接管路径。

`witch_no_mouse_coverage` 用来确认能力是否齐全；`witch_no_mouse_record_evidence` 用来在不同游戏状态下记录紧凑证据，包括操作族和 action 类型摘要；`witch_no_mouse_probe_operation` 可以对当前某个 no-mouse operation 做 dry-run 或显式真实执行，并把操作级结果写入证据日志；`witch_no_mouse_collect_ready_evidence` 会自动挑选当前 ready 的 no-mouse operations 批量 probe，默认 dry-run，真实执行需要 `confirm:"EXECUTE_NO_MOUSE_PROBES"`；`witch_no_mouse_evidence_drive` 会循环执行“计划、采 ready probe、记录证据、严格审计”，直到完成、达到轮数上限或当前状态没有 ready 证明步骤；`witch_no_mouse_watch_evidence` 会在一段时间内监听证据机会，一旦缺口 ready probe 出现就自动采证；当当前状态没有 ready 缺口时，`witch_no_mouse_evidence_plan` 和 `witch_no_mouse_evidence_drive` 会返回 `stateAdvanceCandidates`，给出可能进入下一游戏状态的 no-mouse 调用候选；`witch_no_mouse_restart_collect_audit` 会在显式 `confirm:"RESTART_WITCH_GAME"` 后重启游戏、等待桥接、采状态证据、采 ready probe 并跑严格审计；`witch_no_mouse_evidence_plan` 会把严格审计里的缺口转换成当前可执行的 `witch_no_mouse_probe_operation` 探针、需要进入的游戏状态或需要重启加载 DLL 的步骤；`witch_no_mouse_completion_audit` 更严格，用来判断是否已经足以宣布“完全无鼠标接管”目标完成。它会要求 UI、场景、战斗、合法动作等操作族都有现场证据；证据不足时会返回 `complete:false` 和下一步建议，而不是把单一界面的成功误报为全局完成。

证据日志默认写入仓库本地的 `.witch-no-mouse-evidence.json`，该文件已被 `.gitignore` 排除，不会上传到公开仓库。

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
确认重启时，MCP 会先在游戏进程退出后把仓库中的新版 `bridge-mod/Scripts/Entry.dll` 同步到游戏 Data Mod 目录，再启动游戏并执行验证。`witch_restart_and_watch_bridge` 和 `witch_no_mouse_restart_collect_audit` 使用同一条同步逻辑。

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
