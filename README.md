# 魔女终末旅途 MCP

[![test](https://github.com/Inque-Loic/witch-journey-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/Inque-Loic/witch-journey-mcp/actions/workflows/test.yml)

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

当前 MCP server 暴露 61 个工具，覆盖：

- 桥接状态检查、等待、重启编排
- 本地运行时诊断、Mod 文件检查、桥文件新旧检查
- 接管前准备、readiness 检查、完整接管审计
- UI 快照、UI 点击和交互
- 场景对象快照、场景交互、raycast
- 截图、窗口聚焦、本地 OS 输入兜底
- 桥接 DLL 同步检查与确认式同步，例如 `witch_sync_bridge_artifacts`
- 游戏合法动作、战斗快照、出牌、合法动作匹配、有边界的自动驾驶
- 运行时类型/对象检查、组件成员枚举、组件方法 dry-run/确认调用、组件属性 dry-run/确认写入、静态运行时方法调用
- 观察-规划-执行辅助，例如 `witch_control_map`、`witch_execute_operation`、`witch_state_summary`、`witch_plan_next`、`witch_execute_plan`、`witch_takeover_step`、`witch_takeover_drive`
- 无鼠标能力审计、运行时覆盖矩阵、跨状态证据记录、操作级探针、ready 操作批量采证、证据驱动循环、证据机会监听、确认式状态推进、确认式重启后采证、完整证明编排、证据缺口计划和严格完成度审计，例如 `witch_no_mouse_audit`、`witch_no_mouse_coverage`、`witch_no_mouse_record_evidence`、`witch_no_mouse_probe_operation`、`witch_no_mouse_collect_ready_evidence`、`witch_no_mouse_evidence_drive`、`witch_no_mouse_state_advance_drive`、`witch_no_mouse_watch_evidence`、`witch_no_mouse_restart_collect_audit`、`witch_no_mouse_restart_advance_audit`、`witch_no_mouse_evidence_plan`、`witch_no_mouse_completion_audit`

建议对接管循环、组件调用、组件写入、静态运行时调用先使用 dry-run，确认目标和参数后再执行真实动作。

如果客户端想用统一入口接管当前可见操作，推荐先调用 `witch_control_map` 获取当前合法动作、UI、场景和战斗操作列表，再用 `witch_execute_operation` 按 `operationId`、`family/action`、`label` 或 `index` 执行对应的 no-mouse MCP 调用。`witch_execute_operation` 默认 `dryRun:true`，只有显式传 `dryRun:false` 才会真实执行，并且会拒绝任何映射到 OS 鼠标的操作。

## 无鼠标模式

MCP 默认不使用 OS 鼠标。也就是说：

- `witch_perform_action_match` / `witch_auto_step` / `witch_auto_drive` 走游戏自己的合法动作层。
- `witch_ui_interact` 和 `witch_ui_click_label` 走游戏内 UI 自动化，即使 action 名叫 `click`，也不是移动 Windows 鼠标。
- `witch_scene_interact` 走游戏内场景自动化，也不是移动 Windows 鼠标。
- `witch_battle_snapshot` 可以观察战斗手牌和可选目标，`witch_play_card` 可以按卡牌/目标参数出牌，不需要移动鼠标去点卡牌；如果运行中的旧桥接还不认识 `battle.play_card`，MCP 会尝试通过 `RuntimeBattleAutomationService.PlayCardAsync` 走 runtime fallback。
- `witch_input_mouse` 和 `witch_bridge_command` 里的 `input.mouse` 默认返回 `mouse_forbidden`，不会触发 `SetCursorPos` 或 `mouse_event`。

如果确实要临时恢复 OS 鼠标兜底，可以设置环境变量 `WITCH_JOURNEY_NO_MOUSE=0`，或单次调用 `witch_input_mouse` 时传 `noMouse:false`。不建议把它作为自动接管路径。

`witch_no_mouse_coverage` 用来确认能力是否齐全；`witch_no_mouse_record_evidence` 用来在不同游戏状态下记录紧凑证据，包括操作族和 action 类型摘要；`witch_no_mouse_probe_operation` 可以对当前某个 no-mouse operation 做 dry-run 或显式真实执行，并把操作级结果写入证据日志；`witch_no_mouse_collect_ready_evidence` 会自动挑选当前 ready 的 no-mouse operations 批量 probe，默认 dry-run，真实执行需要 `confirm:"EXECUTE_NO_MOUSE_PROBES"`；`witch_no_mouse_evidence_drive` 会循环执行“计划、采 ready probe、记录证据、严格审计”，直到完成、达到轮数上限或当前状态没有 ready 证明步骤；`witch_no_mouse_state_advance_drive` 会在采证循环之间选择排序最高的 `stateAdvanceCandidates`，默认只 dry-run 展示将执行的 no-mouse 操作，真实推进游戏状态需要 `confirm:"ADVANCE_NO_MOUSE_STATE"`，并支持 `allowOperationIds`、`denyOperationIds`、`allowLabels`、`denyLabels`、`allowPaths`、`denyPaths` 约束候选范围；`witch_no_mouse_watch_evidence` 会在一段时间内监听证据机会，一旦缺口 ready probe 出现就自动采证；当当前状态没有 ready 缺口时，`witch_no_mouse_evidence_plan` 和 `witch_no_mouse_evidence_drive` 会返回 `stateAdvanceCandidates`，给出可能进入下一游戏状态的 no-mouse 调用候选；`witch_no_mouse_restart_collect_audit` 会在显式 `confirm:"RESTART_WITCH_GAME"` 后重启游戏、等待桥接、采状态证据、采 ready probe 并跑严格审计；`witch_no_mouse_restart_advance_audit` 是完整证明编排入口，会在 `restartConfirm:"RESTART_WITCH_GAME"` 后重启加载新版桥接、记录证据，再调用状态推进驱动，且同样支持上述 allow/deny 参数；如果要真实推进游戏状态，还需要 `advanceDryRun:false` 和 `advanceConfirm:"ADVANCE_NO_MOUSE_STATE"`；`witch_no_mouse_evidence_plan` 会把严格审计里的缺口转换成当前可执行的 `witch_no_mouse_probe_operation` 探针、需要进入的游戏状态或需要重启加载 DLL 的步骤；`witch_no_mouse_completion_audit` 更严格，用来判断是否已经足以宣布“完全无鼠标接管”目标完成。它会要求 UI、场景、战斗、合法动作等操作族都有现场证据；证据不足时会返回 `complete:false` 和下一步建议，而不是把单一界面的成功误报为全局完成。

证据日志默认写入仓库本地的 `.witch-no-mouse-evidence.json`，该文件已被 `.gitignore` 排除，不会上传到公开仓库。

## 验证

不启动真实游戏桥时，可以运行本地协议测试：

```powershell
npm test
```

如果只想运行不依赖真实游戏进程的 fake bridge 回归：

```powershell
npm run test:fake
```

也可以单独运行：

```powershell
npm run selftest
npm run calltest
npm run orchestration-test
npm run state-advance-policy-test
npm run bridge-sync-test
npm run no-mouse-test
npm run e2e-fake
```

安装桥接 Mod 并重启游戏后，可以运行真实游戏验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\wait-and-verify.ps1 -TimeoutSec 180 -IntervalSec 2
```

如果只想先确认或同步新版桥接 DLL 到游戏 Data Mod 目录，而不关闭/重启游戏，可以调用 MCP 工具 `witch_sync_bridge_artifacts`。该工具默认 `dryRun:true`，真实复制需要 `dryRun:false` 且传入 `confirm:"SYNC_BRIDGE_ARTIFACTS"`。如果目标 DLL 被正在运行的游戏占用，可以传 `waitForUnlock:true`、`timeoutMs` 和 `pollMs`，让工具在你关闭游戏释放文件后自动重试同步。同步后的 DLL 通常要等下一次重启游戏才会被当前进程加载。

如果希望脚本自动重启游戏、等待桥上线、执行审计和完整验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\restart-and-verify.ps1 -ConfirmRestart RESTART_WITCH_GAME
```

`restart-and-verify.ps1` 会关闭并重启游戏。为了避免误操作，它必须传入 `-ConfirmRestart RESTART_WITCH_GAME` 才会执行。
确认重启时，MCP 会先在游戏进程退出后把仓库中的新版 `bridge-mod/Scripts/Entry.dll` 同步到游戏 Data Mod 目录，再启动游戏并执行验证。`witch_restart_and_watch_bridge` 和 `witch_no_mouse_restart_collect_audit` 使用同一条同步逻辑。
`witch_no_mouse_restart_advance_audit` 在没有 `restartConfirm:"RESTART_WITCH_GAME"` 时不会重启游戏，但会返回当前严格审计、缺口计划、状态推进候选和建议调用，方便先审查再执行。

如果目标是证明“完全不使用鼠标也能接管全部游戏内操作”，建议使用专门的证明脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1
```

想先查看所有模式、选项和退出码，可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -Help
```

如果只想知道当前是否已经满足“完全无鼠标接管”的严格证明，不希望脚本关闭、重启、同步或推进游戏，可以运行只读状态检查：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -Status
```

`-Status` 会汇总桥接是否在线、游戏进程是否正在运行、Data 目录桥接 DLL 是否已经带有 `battle.snapshot`、严格审计还缺哪些现场样本，以及下一条推荐命令。如果游戏正在运行且 Data 目录 DLL 还是旧版，同步预览可能显示 `sync_ready_target_may_be_locked`，表示新版源文件已准备好，但目标 DLL 需要等游戏关闭释放后才能可靠替换。它也支持 `-OutputPath`，写出的状态包便于复查当前卡点。

不带确认参数时，它只会预览严格审计缺口和当前无鼠标状态推进候选，不会关闭或重启游戏。确认已经保存好进度并希望加载新版桥接 DLL 后，可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -ConfirmRestart RESTART_WITCH_GAME
```

上面的命令会重启游戏、等待桥接上线、记录证据、执行 dry-run 状态推进计划并跑 `witch_no_mouse_completion_audit`。如果你已经审查过候选操作，并允许脚本真实推进游戏状态，可以额外加 `-ExecuteStateAdvance`；如果还允许真实执行操作探针，可以再加 `-ExecuteProbes`。这两个开关都可能改变当前游戏状态，因此默认关闭。

如果不想让脚本关闭游戏，但希望它在你手动退出游戏后自动同步新版桥接 DLL，可以使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -WaitForDllUnlock
```

这个模式不会关闭或重启游戏，只会等待 `Entry.dll` 可写；你手动关闭游戏释放 DLL 后，它会同步新版桥接。同步完成后，再手动启动游戏并重新运行证明脚本继续严格审计。

如果希望同步成功后继续等待你手动重新启动游戏，并在桥接上线后自动跑一次严格证明预览，可以加：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -WaitForDllUnlock -WaitForBridgeAfterSync
```

如果需要保留机器可读的证明包，可以加 `-OutputPath`：

```powershell
powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -OutputPath .\no-mouse-proof.json
```

证明包会包含严格审计结果、缺失项、状态推进候选和完整 MCP 返回结果，方便之后复查。`-WaitForDllUnlock` 模式也支持 `-OutputPath`，会写出同步结果包；与 `-WaitForBridgeAfterSync` 一起使用时，会写出“同步、等待桥接、证明预览”的连续流程包。它是本地文件；仓库已忽略 `no-mouse-proof*.json`、`witch-no-mouse-proof*.json` 和 `proof-bundles/`，避免常见证明包误上传。如果你把 `-OutputPath` 指到其他文件名或仓库外路径，请按自己的隐私需求管理。

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
