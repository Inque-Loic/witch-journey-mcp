# Witch Journey MCP

Local MCP server plus in-game bridge for controlling *Witch's Apocalyptic Journey* through Codex.

The tool has two parts:

- `server.mjs`: MCP stdio server used by Codex.
- `bridge-mod/`: `CodexMcpBridge` game mod. It opens a localhost HTTP bridge and calls the game's `Witch.UI.Automation.*` runtime surfaces.

The default bridge URL is `http://127.0.0.1:18171`.

## Install

1. Copy `bridge-mod/` to one or both game mod locations, renaming the copied folder to `CodexMcpBridge`:

   ```powershell
   Copy-Item -Recurse -Force .\bridge-mod "<GAME_ROOT>\Mods\CodexMcpBridge"
   Copy-Item -Recurse -Force .\bridge-mod "<GAME_ROOT>\Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge"
   ```

2. Add the MCP server to your Codex config:

   ```toml
   [mcp_servers.witchJourney]
   command = 'node'
   args = ["<PATH_TO_THIS_REPO>\\server.mjs"]
   startup_timeout_sec = 20

   [mcp_servers.witchJourney.env]
   WITCH_JOURNEY_BRIDGE_URL = 'http://127.0.0.1:18171'
   ```

3. Restart the game.

4. Check the bridge:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\check-bridge.ps1
   ```

## Tools

The MCP server exposes 45 tools covering:

- bridge status and wait/restart orchestration
- runtime diagnostics and artifact freshness checks
- readiness and takeover audits
- UI snapshots and UI interactions
- scene snapshots, scene interaction, and raycasts
- screen capture, window focus, and fallback OS input
- legal gameplay actions, card play, legal-action matching, and bounded auto-drive
- runtime type/object inspection, component member enumeration, dry-run/confirmed method calls, dry-run/confirmed member writes, and reviewed static runtime invocation
- observe-plan-act helpers such as `witch_state_summary`, `witch_plan_next`, `witch_execute_plan`, `witch_takeover_step`, and `witch_takeover_drive`

Use dry-run first for takeover loops, component calls, component writes, and static runtime invocation.

## Verification

Run local protocol tests without the real game bridge:

```powershell
npm run selftest
npm run calltest
npm run orchestration-test
npm run e2e-fake
```

Run against a live game after installing the bridge mod and restarting:

```powershell
powershell -ExecutionPolicy Bypass -File .\wait-and-verify.ps1 -TimeoutSec 180 -IntervalSec 2
```

For a full restart plus wait/audit/verification chain:

```powershell
powershell -ExecutionPolicy Bypass -File .\restart-and-verify.ps1 -ConfirmRestart RESTART_WITCH_GAME
```

`restart-and-verify.ps1` can close and restart the game. It refuses to do so unless passed `-ConfirmRestart RESTART_WITCH_GAME`.

## Bridge Build

`bridge-mod/Scripts/Entry.dll` is included. To rebuild it from `bridge-mod/Dev/Entry.cs`, copy or mirror the bridge source into the game mod folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\compile-bridge.ps1
```

The build script uses managed assemblies from the installed game, so it must be run from a checkout located under the game root unless you adapt the paths.

## Safety

- The bridge binds to localhost only.
- Game process restart requires an explicit confirmation token.
- Component calls and component writes default to dry-run and require confirmation strings to execute.
- Action-policy gates can allow or deny specific legal action ids, kinds, or labels before execution.

