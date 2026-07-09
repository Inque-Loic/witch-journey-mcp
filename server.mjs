#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRIDGE_URL = process.env.WITCH_JOURNEY_BRIDGE_URL || "http://127.0.0.1:18171";
const REQUEST_TIMEOUT_MS = Number(process.env.WITCH_JOURNEY_TIMEOUT_MS || 15000);
const DEFAULT_NO_MOUSE = !["0", "false", "False", "FALSE", "no", "No", "NO"].includes(String(process.env.WITCH_JOURNEY_NO_MOUSE || "true"));
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.WITCH_JOURNEY_GAME_ROOT
  ? path.resolve(process.env.WITCH_JOURNEY_GAME_ROOT)
  : path.resolve(SERVER_DIR, "..", "..");
const PLAYER_LOG_PATH = path.join(os.homedir(), "AppData", "LocalLow", "MeowAlive", "Witch's Apocalyptic Journey", "Player.log");
const BRIDGE_MARKERS = [
  "0.9.0",
  "screen.info",
  "screen.capture",
  "window.focus",
  "input.key",
  "input.text",
  "input.mouse",
  "CodexMcpBridgeRunner",
  "runtime.inspect",
  "runtime.objects",
  "runtime.object_detail",
  "runtime.component_members",
  "runtime.component_call",
  "runtime.component_set",
  "runtime.invoke_static"
];
const LOCAL_OS_FALLBACK_COMMANDS = new Set([
  "screen.info",
  "screen.capture",
  "window.focus",
  "input.key",
  "input.text",
  "input.mouse"
]);

const tools = [
  {
    name: "witch_status",
    description: "Check whether the Witch's Apocalyptic Journey in-game Codex MCP bridge is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "witch_wait_bridge",
    description: "Wait for the in-game bridge to become reachable, useful immediately after starting or restarting the game.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", default: 30000 },
        pollMs: { type: "integer", default: 500 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_watch_bridge_load",
    description: "Watch bridge loading after a game start/restart by polling bridge status and Player.log evidence, then classify timeout causes or optionally run takeover audit once the bridge appears.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", default: 120000 },
        pollMs: { type: "integer", default: 1000 },
        logTailLines: { type: "integer", default: 120 },
        runAuditWhenReady: { type: "boolean", default: true },
        includeScreenshot: { type: "boolean", default: false },
        includeRuntimeInspect: { type: "boolean", default: true },
        includeLowLevelRuntimeChecks: { type: "boolean", default: true },
        includeLocalOsFallbackChecks: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_restart_and_watch_bridge",
    description: "Confirmed one-shot orchestration: close/restart the game, launch it again, watch bridge loading, and optionally run takeover audit once the bridge appears. Requires confirm=RESTART_WITCH_GAME.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "Required as RESTART_WITCH_GAME to close/restart the current game process." },
        gracefulCloseTimeoutMs: { type: "integer", default: 8000 },
        timeoutMs: { type: "integer", default: 120000 },
        pollMs: { type: "integer", default: 1000 },
        logTailLines: { type: "integer", default: 120 },
        runAuditWhenReady: { type: "boolean", default: true },
        includeScreenshot: { type: "boolean", default: false },
        includeRuntimeInspect: { type: "boolean", default: true },
        includeLowLevelRuntimeChecks: { type: "boolean", default: true },
        includeLocalOsFallbackChecks: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_capabilities",
    description: "Describe the available MCP tools, bridge commands, UI actions, scene actions, and wait conditions without requiring the game bridge to be online.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_audit",
    description: "Audit whether MCP takeover can operate without OS mouse input: operation-family coverage, default policy, forbidden mouse entry points, and optional current-state no-mouse affordances.",
    inputSchema: {
      type: "object",
      properties: {
        includeCurrentState: { type: "boolean", default: true },
        includePolicyTests: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_coverage",
    description: "Collect live no-mouse coverage evidence from the running game: MCP tools, bridge commands, runtime automation services, and current control-map samples.",
    inputSchema: {
      type: "object",
      properties: {
        includeCurrentState: { type: "boolean", default: true },
        includePolicyTests: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_diagnostics",
    description: "Inspect local runtime state without requiring the bridge: process, installed mod files, DLL command markers, Player.log evidence, and bridge status.",
    inputSchema: {
      type: "object",
      properties: {
        includeLogTail: { type: "boolean", default: false },
        logTailLines: { type: "integer", default: 120 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_prepare_takeover",
    description: "Prepare for full Codex takeover: diagnose local state, optionally launch the game if it is not running, wait for the bridge, and run readiness verification. It never terminates an existing game process unless restartIfRunning is true.",
    inputSchema: {
      type: "object",
      properties: {
        launchIfNotRunning: { type: "boolean", default: true },
        restartIfRunning: { type: "boolean", default: false },
        confirm: { type: "string", description: "Required as RESTART_WITCH_GAME when restartIfRunning is true." },
        gracefulCloseTimeoutMs: { type: "integer", default: 8000 },
        waitBridge: { type: "boolean", default: true },
        bridgeTimeoutMs: { type: "integer", default: 60000 },
        bridgePollMs: { type: "integer", default: 500 },
        runReadiness: { type: "boolean", default: true },
        includeScreenshot: { type: "boolean", default: true },
        includeRuntimeInspect: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_verify_readiness",
    description: "Run a read-only/dry-run readiness audit proving whether Codex can observe, plan, capture visual evidence, and safely preview takeover.",
    inputSchema: {
      type: "object",
      properties: {
        bridgeTimeoutMs: { type: "integer", default: 30000 },
        bridgePollMs: { type: "integer", default: 500 },
        includeScreenshot: { type: "boolean", default: true },
        screenshotPath: { type: "string" },
        screenshotDirectory: { type: "string" },
        screenshotTimeoutMs: { type: "integer", default: 5000 },
        screenshotPollMs: { type: "integer", default: 100 },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeRuntimeInspect: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_takeover_audit",
    description: "Run a requirement-style audit for full Codex takeover readiness, combining local diagnostics with read-only/dry-run bridge checks when the game bridge is online.",
    inputSchema: {
      type: "object",
      properties: {
        bridgeTimeoutMs: { type: "integer", default: 30000 },
        bridgePollMs: { type: "integer", default: 500 },
        includeScreenshot: { type: "boolean", default: true },
        screenshotPath: { type: "string" },
        screenshotDirectory: { type: "string" },
        screenshotTimeoutMs: { type: "integer", default: 5000 },
        screenshotPollMs: { type: "integer", default: 100 },
        includeRuntimeInspect: { type: "boolean", default: true },
        includeLowLevelRuntimeChecks: { type: "boolean", default: true },
        includeLocalOsFallbackChecks: { type: "boolean", default: true },
        includeLogTail: { type: "boolean", default: false },
        logTailLines: { type: "integer", default: 120 },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_game_snapshot",
    description: "Capture a broad current-game snapshot: bridge status, UI tree, scene objects, and high-level legal gameplay actions.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeUi: { type: "boolean", default: true },
        includeScene: { type: "boolean", default: true },
        includeLegalActions: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_control_map",
    description: "Build a complete no-mouse operation map for the current state: legal actions, UI affordances, and scene affordances converted into ready MCP calls.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeActions: { type: "boolean", default: true },
        includeUi: { type: "boolean", default: true },
        includeScene: { type: "boolean", default: true },
        includeUnsupported: { type: "boolean", default: true },
        maxActions: { type: "integer", default: 200 },
        maxUiNodes: { type: "integer", default: 200 },
        maxSceneObjects: { type: "integer", default: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_state_summary",
    description: "Capture a compact decision-oriented summary of the current game state: windows, clickable UI, scene interactables, legal actions, and a suggested next legal action.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        maxUiNodes: { type: "integer", default: 20 },
        maxSceneObjects: { type: "integer", default: 20 },
        maxActions: { type: "integer", default: 20 },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_plan_next",
    description: "Build a non-executing next-step plan from the compact state summary, including the recommended MCP tool call and conservative alternatives.",
    inputSchema: {
      type: "object",
      properties: {
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        allowUiFallback: { type: "boolean", default: true },
        allowSceneFallback: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_execute_plan",
    description: "Plan the next action and optionally execute the recommended MCP call, returning the plan, execution result, and optional post-action summary.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        includePostSummary: { type: "boolean", default: true },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        allowUiFallback: { type: "boolean", default: true },
        allowSceneFallback: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_takeover_step",
    description: "Run one full takeover loop: wait for bridge, focus window, capture visual evidence, summarize state, plan, optionally execute, and optionally resummarize.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        waitBridge: { type: "boolean", default: true },
        bridgeTimeoutMs: { type: "integer", default: 30000 },
        bridgePollMs: { type: "integer", default: 500 },
        focusWindow: { type: "boolean", default: true },
        includeScreenshot: { type: "boolean", default: true },
        screenshotPath: { type: "string" },
        screenshotDirectory: { type: "string" },
        screenshotTimeoutMs: { type: "integer", default: 5000 },
        screenshotPollMs: { type: "integer", default: 100 },
        includePostSummary: { type: "boolean", default: true },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        allowUiFallback: { type: "boolean", default: true },
        allowSceneFallback: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_takeover_drive",
    description: "Run bounded repeated takeover loops. Defaults to dry-run and stops on configured action ids, kinds, labels, failures, or maxSteps.",
    inputSchema: {
      type: "object",
      properties: {
        maxSteps: { type: "integer", default: 3 },
        dryRun: { type: "boolean", default: true },
        stopOnFailure: { type: "boolean", default: true },
        stopOnActionIds: { type: "array", items: { type: "string" } },
        stopOnKinds: { type: "array", items: { type: "string" } },
        stopOnLabels: { type: "array", items: { type: "string" } },
        waitAfterMs: { type: "integer", default: 250 },
        waitBridge: { type: "boolean", default: true },
        bridgeTimeoutMs: { type: "integer", default: 30000 },
        bridgePollMs: { type: "integer", default: 500 },
        focusWindow: { type: "boolean", default: true },
        includeScreenshot: { type: "boolean", default: true },
        screenshotPath: { type: "string" },
        screenshotDirectory: { type: "string" },
        screenshotTimeoutMs: { type: "integer", default: 5000 },
        screenshotPollMs: { type: "integer", default: 100 },
        includePostSummary: { type: "boolean", default: true },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        allowUiFallback: { type: "boolean", default: true },
        allowSceneFallback: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_find_targets",
    description: "Search current UI nodes, scene objects, and legal actions by text/query and return selectors or action ids ready for interaction.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        includeUi: { type: "boolean", default: true },
        includeScene: { type: "boolean", default: true },
        includeActions: { type: "boolean", default: true },
        maxResults: { type: "integer", default: 20 },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_batch",
    description: "Run a bounded sequence of approved Witch MCP tool calls. Defaults to dry-run for action tools and returns each step result.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        stopOnError: { type: "boolean", default: true },
        maxSteps: { type: "integer", default: 10 },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              arguments: { type: "object", additionalProperties: true }
            },
            required: ["tool"],
            additionalProperties: false
          }
        }
      },
      required: ["steps"],
      additionalProperties: false
    }
  },
  {
    name: "witch_ui_snapshot",
    description: "Capture the current Unity UI tree, including windows, clickable nodes, labels, layout ids, and optional hidden nodes.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Optional UI scope/window filter understood by the game automation layer." },
        includeHidden: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_ui_interact",
    description: "Interact with a UI node by selector. Supports click, double_click, hover, set_text, submit, scroll, and drag.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        selector: { "$ref": "#/$defs/uiSelector" },
        targetSelector: { "$ref": "#/$defs/uiSelector" },
        targetPoint: { "$ref": "#/$defs/point" },
        text: { type: "string" },
        submit: { type: "boolean" },
        requireClickable: { type: "boolean" },
        button: { type: "string" },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        steps: { type: "integer" },
        framesPerStep: { type: "integer" },
        includePostSnapshot: { type: "boolean" }
      },
      required: ["action"],
      additionalProperties: false,
      "$defs": commonDefs()
    }
  },
  {
    name: "witch_ui_click_label",
    description: "Click a visible UI node by label, optionally scoped to a window. This is a convenience wrapper over witch_ui_interact.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        windowName: { type: "string" },
        requireClickable: { type: "boolean", default: true },
        includePostSnapshot: { type: "boolean", default: true }
      },
      required: ["label"],
      additionalProperties: false
    }
  },
  {
    name: "witch_ui_wait",
    description: "Evaluate or poll for a UI condition such as node_exists, window_exists, text_contains, layout_changed, node_gone.",
    inputSchema: {
      type: "object",
      properties: {
        condition: { type: "string" },
        selector: { "$ref": "#/$defs/uiSelector" },
        windowName: { type: "string" },
        expectedText: { type: "string" },
        timeoutMs: { type: "integer", default: 5000 },
        pollMs: { type: "integer", default: 250 }
      },
      required: ["condition"],
      additionalProperties: false,
      "$defs": commonDefs()
    }
  },
  {
    name: "witch_scene_snapshot",
    description: "Capture interactive scene objects, visible transforms, colliders, pointer handlers, and screen positions.",
    inputSchema: {
      type: "object",
      properties: {
        includeInactive: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_scene_interact",
    description: "Interact with world/scene objects by selector or screen point. Supports click, hover, drag, and scroll.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        selector: { "$ref": "#/$defs/sceneSelector" },
        targetSelector: { "$ref": "#/$defs/sceneSelector" },
        screenPoint: { "$ref": "#/$defs/point" },
        targetPoint: { "$ref": "#/$defs/point" },
        button: { type: "string" },
        scrollX: { type: "number" },
        scrollY: { type: "number" },
        steps: { type: "integer" },
        framesPerStep: { type: "integer" }
      },
      required: ["action"],
      additionalProperties: false,
      "$defs": commonDefs()
    }
  },
  {
    name: "witch_scene_raycast",
    description: "Raycast from a screen point and return hit objects.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        distance: { type: "number", default: 1000 }
      },
      required: ["x", "y"],
      additionalProperties: false
    }
  },
  {
    name: "witch_screen_info",
    description: "Return game screen/window information. Uses the in-game bridge when available and falls back to local OS window inspection when the bridge is offline.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "witch_screen_capture",
    description: "Capture a screenshot PNG and return the output path. Uses the in-game bridge when available and falls back to a local OS window capture when the bridge is offline.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        directory: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_screen_capture_wait",
    description: "Capture a screenshot and wait until the PNG file exists on disk, returning path, size, and wait timing. Supports local OS fallback when the bridge is offline.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        directory: { type: "string" },
        timeoutMs: { type: "integer", default: 5000 },
        pollMs: { type: "integer", default: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_window_focus",
    description: "Focus and restore the game window before fallback OS-level input. Uses local OS control if the in-game bridge is offline.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "witch_input_key",
    description: "Fallback OS-level keyboard input for the game window. Uses the in-game bridge when available and local OS input when offline. Prefer game legal actions or UI tools first.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        action: { type: "string", default: "press" },
        repeat: { type: "integer", default: 1 },
        modifiers: { type: "array", items: { type: "string" } },
        focus: { type: "boolean", default: true }
      },
      required: ["key"],
      additionalProperties: false
    }
  },
  {
    name: "witch_input_text",
    description: "Fallback OS-level unicode text input. Uses the in-game bridge when available and local OS input when offline. Prefer witch_ui_interact set_text when a UI selector is available.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        focus: { type: "boolean", default: true }
      },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "witch_input_mouse",
    description: "Fallback OS-level mouse input using game-window coordinates. Disabled by default in no-mouse mode. Prefer legal actions, UI automation, scene automation, or runtime calls.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", default: "click" },
        button: { type: "string", default: "left" },
        origin: { type: "string", default: "unity" },
        x: { type: "number" },
        y: { type: "number" },
        targetX: { type: "number" },
        targetY: { type: "number" },
        steps: { type: "integer", default: 12 },
        delta: { type: "integer" },
        scrollY: { type: "integer" },
        focus: { type: "boolean", default: true },
        noMouse: { type: "boolean", default: true, description: "When true, refuse OS-level mouse input. Defaults to WITCH_JOURNEY_NO_MOUSE, which is true unless explicitly disabled." }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_legal_actions",
    description: "Return high-level legal gameplay actions for the current phase, when the game can infer them.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "witch_perform_action",
    description: "Perform one high-level legal action returned by witch_legal_actions.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string" }
      },
      required: ["actionId"],
      additionalProperties: false
    }
  },
  {
    name: "witch_play_card",
    description: "Play a battle card by card instance id, card id, or hand index, optionally targeting an enemy/object by id, name, or index.",
    inputSchema: {
      type: "object",
      properties: {
        cardInstanceId: { type: "integer" },
        cardId: { type: "string" },
        cardIndex: { type: "integer" },
        targetInstanceId: { type: "integer" },
        targetName: { type: "string" },
        targetIndex: { type: "integer" }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_inspect",
    description: "Ask the in-game bridge to inspect loaded runtime types and members, useful for discovering hidden automation/debug/control surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        assembly: { type: "string" },
        includeNonPublic: { type: "boolean", default: false },
        includeProperties: { type: "boolean", default: true },
        includeFields: { type: "boolean", default: false },
        maxTypes: { type: "integer", default: 80 },
        maxMembersPerType: { type: "integer", default: 30 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_objects",
    description: "Inspect loaded Unity GameObjects and components from the in-game bridge by name/path, tag, layer, or component type.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        componentType: { type: "string" },
        tag: { type: "string" },
        layerName: { type: "string" },
        includeInactive: { type: "boolean", default: false },
        includeComponents: { type: "boolean", default: true },
        includeBounds: { type: "boolean", default: true },
        maxObjects: { type: "integer", default: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_object_detail",
    description: "Inspect one Unity GameObject in detail by instanceId, path, name, or query, including selected component public properties and fields.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "integer" },
        path: { type: "string" },
        name: { type: "string" },
        query: { type: "string" },
        componentType: { type: "string" },
        includeInactive: { type: "boolean", default: true },
        includeProperties: { type: "boolean", default: true },
        includeFields: { type: "boolean", default: false },
        maxMembersPerComponent: { type: "integer", default: 40 },
        maxStringLength: { type: "integer", default: 500 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_component_call",
    description: "Dry-run or confirmed invoke a public instance method on a selected Unity component. Defaults to dry-run and requires confirm=CALL_WITCH_COMPONENT_METHOD to execute.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "integer" },
        path: { type: "string" },
        name: { type: "string" },
        query: { type: "string" },
        componentType: { type: "string" },
        methodName: { type: "string" },
        arguments: { type: "array" },
        includeInactive: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as CALL_WITCH_COMPONENT_METHOD when dryRun is false." },
        maxStringLength: { type: "integer", default: 500 }
      },
      required: ["componentType", "methodName"],
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_component_members",
    description: "Enumerate public methods, properties, and fields on a selected Unity component, optionally including readable values.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "integer" },
        path: { type: "string" },
        name: { type: "string" },
        query: { type: "string" },
        componentType: { type: "string" },
        memberQuery: { type: "string" },
        includeInactive: { type: "boolean", default: true },
        includeMethods: { type: "boolean", default: true },
        includeProperties: { type: "boolean", default: true },
        includeFields: { type: "boolean", default: true },
        includeValues: { type: "boolean", default: false },
        maxMembersPerComponent: { type: "integer", default: 120 },
        maxStringLength: { type: "integer", default: 500 }
      },
      required: ["componentType"],
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_component_set",
    description: "Dry-run or confirmed set a public writable property or field on a selected Unity component. Defaults to dry-run and requires confirm=SET_WITCH_COMPONENT_MEMBER to execute.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "integer" },
        path: { type: "string" },
        name: { type: "string" },
        query: { type: "string" },
        componentType: { type: "string" },
        memberName: { type: "string" },
        memberKind: { type: "string", enum: ["property", "field"] },
        value: {},
        includeInactive: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as SET_WITCH_COMPONENT_MEMBER when dryRun is false." },
        maxStringLength: { type: "integer", default: 500 }
      },
      required: ["componentType", "memberName", "value"],
      additionalProperties: false
    }
  },
  {
    name: "witch_runtime_invoke_static",
    description: "Invoke an allowed public static runtime method. Witch.UI.Automation.* is allowed by default; pass explicit allowPrefixes for other discovered surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string" },
        methodName: { type: "string" },
        arguments: { type: "array" },
        allowPrefixes: { type: "array", items: { type: "string" } }
      },
      required: ["typeName", "methodName"],
      additionalProperties: false
    }
  },
  {
    name: "witch_perform_action_match",
    description: "Find a high-level legal gameplay action by id, label, kind, or index, then perform it. Use after witch_legal_actions or witch_game_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        label: { type: "string" },
        kind: { type: "string" },
        index: { type: "integer" },
        contains: { type: "boolean", default: true },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_auto_step",
    description: "Choose and perform one high-level legal gameplay action using optional preferences. This is the safest primitive for autonomous play because it only uses actions reported legal by the game.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: false },
        actionId: { type: "string" },
        label: { type: "string" },
        kind: { type: "string" },
        index: { type: "integer" },
        contains: { type: "boolean", default: true },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        includeLegalActions: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_auto_drive",
    description: "Repeatedly choose and perform high-level legal gameplay actions for a bounded number of steps, returning every decision and result.",
    inputSchema: {
      type: "object",
      properties: {
        maxSteps: { type: "integer", default: 5 },
        dryRun: { type: "boolean", default: false },
        stopOnNoActions: { type: "boolean", default: true },
        stopOnActionIds: { type: "array", items: { type: "string" } },
        stopOnKinds: { type: "array", items: { type: "string" } },
        stopOnLabels: { type: "array", items: { type: "string" } },
        preferKinds: { type: "array", items: { type: "string" } },
        preferLabels: { type: "array", items: { type: "string" } },
        avoidKinds: { type: "array", items: { type: "string" } },
        avoidLabels: { type: "array", items: { type: "string" } },
        allowActionIds: { type: "array", items: { type: "string" } },
        allowKinds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyActionIds: { type: "array", items: { type: "string" } },
        denyKinds: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        waitAfterMs: { type: "integer", default: 250 },
        includeSnapshots: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_bridge_command",
    description: "Low-level escape hatch for new in-game bridge commands. Prefer the typed tools when possible.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        params: { type: "object", additionalProperties: true }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];

function commonDefs() {
  return {
    point: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" }
      },
      required: ["x", "y"],
      additionalProperties: false
    },
    uiSelector: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        instanceId: { type: "integer" },
        windowName: { type: "string" },
        transformPath: { type: "string" },
        label: { type: "string" }
      },
      additionalProperties: false
    },
    sceneSelector: {
      type: "object",
      properties: {
        objectId: { type: "string" },
        instanceId: { type: "integer" },
        transformPath: { type: "string" },
        name: { type: "string" }
      },
      additionalProperties: false
    }
  };
}

function toolToBridge(name, args) {
  switch (name) {
    case "witch_status":
      return { command: "status", params: args || {} };
    case "witch_ui_click_label":
      return {
        command: "ui.interact",
        params: {
          action: "click",
          selector: { label: args?.label, windowName: args?.windowName },
          requireClickable: args?.requireClickable !== false,
          includePostSnapshot: args?.includePostSnapshot !== false
        }
      };
    case "witch_ui_snapshot":
      return { command: "ui.snapshot", params: { scope: args?.scope || "", includeHidden: !!args?.includeHidden } };
    case "witch_ui_interact":
      return { command: "ui.interact", params: args || {} };
    case "witch_ui_wait":
      return { command: "ui.wait", params: args || {} };
    case "witch_scene_snapshot":
      return { command: "scene.snapshot", params: { includeInactive: !!args?.includeInactive, onlyInteractive: args?.onlyInteractive !== false } };
    case "witch_scene_interact":
      return { command: "scene.interact", params: args || {} };
    case "witch_scene_raycast":
      return { command: "scene.raycast", params: args || {} };
    case "witch_screen_info":
      return { command: "screen.info", params: args || {} };
    case "witch_screen_capture":
      return { command: "screen.capture", params: args || {} };
    case "witch_screen_capture_wait":
      return { command: "screen.capture", params: args || {} };
    case "witch_window_focus":
      return { command: "window.focus", params: args || {} };
    case "witch_input_key":
      return { command: "input.key", params: args || {} };
    case "witch_input_text":
      return { command: "input.text", params: args || {} };
    case "witch_input_mouse":
      return { command: "input.mouse", params: args || {} };
    case "witch_legal_actions":
      return { command: "game.legal_actions", params: args || {} };
    case "witch_perform_action":
      return { command: "game.perform_action", params: args || {} };
    case "witch_play_card":
      return { command: "battle.play_card", params: args || {} };
    case "witch_runtime_inspect":
      return { command: "runtime.inspect", params: args || {} };
    case "witch_runtime_objects":
      return { command: "runtime.objects", params: args || {} };
    case "witch_runtime_object_detail":
      return { command: "runtime.object_detail", params: args || {} };
    case "witch_runtime_component_members":
      return { command: "runtime.component_members", params: args || {} };
    case "witch_runtime_component_call":
      return { command: "runtime.component_call", params: args || {} };
    case "witch_runtime_component_set":
      return { command: "runtime.component_set", params: args || {} };
    case "witch_runtime_invoke_static":
      return { command: "runtime.invoke_static", params: args || {} };
    case "witch_bridge_command":
      return { command: args.command, params: args.params || {} };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callBridge(command, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BRIDGE_URL}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, params: params || {} }),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Witch bridge timed out at ${BRIDGE_URL}. Start or restart the game so CodexMcpBridge can load.`);
    }
    if (error?.message === "fetch failed" || error?.cause) {
      throw new Error(`Witch bridge is not reachable at ${BRIDGE_URL}. Start or restart the game so CodexMcpBridge can load.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callBridgeWithLocalFallback(command, params) {
  const mouseGuard = rejectMouseCommand(command, params);
  if (mouseGuard) {
    return mouseGuard;
  }
  try {
    return await callBridge(command, params);
  } catch (error) {
    if (!LOCAL_OS_FALLBACK_COMMANDS.has(command)) {
      throw error;
    }
    return localOsCommand(command, params || {}, error);
  }
}

function noMouseEnabled(args) {
  if (args?.noMouse === true) return true;
  if (args?.noMouse === false) return false;
  return DEFAULT_NO_MOUSE;
}

function rejectMouseCommand(command, params) {
  if (command !== "input.mouse" || !noMouseEnabled(params || {})) {
    return null;
  }
  return {
    ok: false,
    reason: "mouse_forbidden",
    command,
    noMouse: true,
    message: "OS-level mouse input is disabled. Use witch_legal_actions/witch_perform_action_match, witch_ui_interact, witch_scene_interact, or runtime tools instead.",
    alternatives: [
      "witch_perform_action_match",
      "witch_ui_interact",
      "witch_scene_interact",
      "witch_runtime_invoke_static"
    ]
  };
}

async function handleRequest(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "witch-journey-mcp", version: "0.1.0" }
      }
    };
  }
  if (method === "notifications/initialized") {
    return null;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (String(method || "").startsWith("notifications/")) {
    return null;
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools } };
  }
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    if (toolName === "witch_capabilities") {
      return toolResult(id, localCapabilities());
    }
    if (toolName === "witch_no_mouse_audit") {
      return toolResult(id, await noMouseAudit(args));
    }
    if (toolName === "witch_no_mouse_coverage") {
      return toolResult(id, await noMouseCoverage(args));
    }
    if (toolName === "witch_runtime_diagnostics") {
      return toolResult(id, await runtimeDiagnostics(args));
    }
    if (toolName === "witch_prepare_takeover") {
      return toolResult(id, await prepareTakeover(args));
    }
    if (toolName === "witch_wait_bridge") {
      return toolResult(id, await waitForBridge(args));
    }
    if (toolName === "witch_watch_bridge_load") {
      return toolResult(id, await watchBridgeLoad(args));
    }
    if (toolName === "witch_restart_and_watch_bridge") {
      return toolResult(id, await restartAndWatchBridge(args));
    }
    if (toolName === "witch_verify_readiness") {
      return toolResult(id, await verifyReadiness(args));
    }
    if (toolName === "witch_takeover_audit") {
      return toolResult(id, await takeoverAudit(args));
    }
    if (toolName === "witch_game_snapshot") {
      return toolResult(id, await collectGameSnapshot(args));
    }
    if (toolName === "witch_control_map") {
      return toolResult(id, await collectControlMap(args));
    }
    if (toolName === "witch_state_summary") {
      return toolResult(id, await collectStateSummary(args));
    }
    if (toolName === "witch_plan_next") {
      return toolResult(id, await planNext(args));
    }
    if (toolName === "witch_execute_plan") {
      return toolResult(id, await executePlan(args));
    }
    if (toolName === "witch_takeover_step") {
      return toolResult(id, await takeoverStep(args));
    }
    if (toolName === "witch_takeover_drive") {
      return toolResult(id, await takeoverDrive(args));
    }
    if (toolName === "witch_find_targets") {
      return toolResult(id, await findTargets(args));
    }
    if (toolName === "witch_batch") {
      return toolResult(id, await runBatch(args));
    }
    if (toolName === "witch_perform_action_match") {
      return toolResult(id, await performMatchingAction(args));
    }
    if (toolName === "witch_auto_step") {
      return toolResult(id, await autoStep(args));
    }
    if (toolName === "witch_auto_drive") {
      return toolResult(id, await autoDrive(args));
    }
    if (toolName === "witch_screen_capture_wait") {
      return toolResult(id, await captureAndWait(args));
    }
    const mapped = toolToBridge(toolName, args);
    const result = toolName === "witch_ui_wait"
      ? await waitForUi(args)
      : await callBridgeWithLocalFallback(mapped.command, mapped.params);
    return toolResult(id, result);
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

function toolResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  };
}

async function waitForUi(args) {
  const timeoutMs = Number(args?.timeoutMs ?? 5000);
  const pollMs = Math.max(50, Number(args?.pollMs ?? 250));
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt <= timeoutMs) {
    last = await callBridge("ui.wait", args || {});
    if (last?.ok && last?.data?.Satisfied === true) {
      return { ...last, waitedMs: Date.now() - startedAt, timedOut: false };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return { ok: false, timedOut: true, waitedMs: Date.now() - startedAt, last };
}

async function waitForBridge(args) {
  const timeoutMs = Math.max(0, Number(args?.timeoutMs ?? 30000));
  const pollMs = Math.max(50, Number(args?.pollMs ?? 500));
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt <= timeoutMs) {
    last = await safeCallBridge("status", {});
    if (last?.ok) {
      return {
        ok: true,
        timedOut: false,
        waitedMs: Date.now() - startedAt,
        status: last
      };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return {
    ok: false,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    last
  };
}

async function watchBridgeLoad(args) {
  const timeoutMs = Math.max(0, Number(args?.timeoutMs ?? 120000));
  const pollMs = Math.max(100, Number(args?.pollMs ?? 1000));
  const logTailLines = clampInt(args?.logTailLines, 120, 20, 500);
  const startedAt = Date.now();
  const events = [];
  let lastBridgeOk = null;
  let lastLogSignature = "";
  let lastStatus = null;
  let lastLogEvidence = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    const status = await safeCallBridge("status", {});
    lastStatus = status;
    if (status?.ok !== lastBridgeOk) {
      events.push({
        elapsedMs,
        type: "bridge_status",
        ok: status?.ok === true,
        status: summarizeBridgeStatus(status)
      });
      lastBridgeOk = status?.ok === true;
    }

    const logEvidence = await inspectPlayerLog(false, logTailLines);
    lastLogEvidence = logEvidence;
    const logSignature = [
      logEvidence?.modifiedAtUtc || "",
      logEvidence?.sizeBytes || 0,
      logEvidence?.hasBridgeEvidence ? "bridge" : "no_bridge",
      (logEvidence?.bridgeEvidence || []).slice(-3).join("\n"),
      (logEvidence?.recentModEvidence || []).slice(-5).join("\n")
    ].join("|");
    if (logSignature !== lastLogSignature) {
      events.push({
        elapsedMs,
        type: "player_log",
        hasBridgeEvidence: logEvidence?.hasBridgeEvidence === true,
        modifiedAtUtc: logEvidence?.modifiedAtUtc,
        bridgeEvidence: (logEvidence?.bridgeEvidence || []).slice(-10),
        recentModEvidence: (logEvidence?.recentModEvidence || []).slice(-10)
      });
      lastLogSignature = logSignature;
    }

    if (status?.ok) {
      const result = {
        ok: true,
        timedOut: false,
        waitedMs: elapsedMs,
        status,
        playerLog: logEvidence,
        events
      };
      if (args?.runAuditWhenReady !== false) {
        result.takeoverAudit = await takeoverAudit({
          bridgeTimeoutMs: Math.max(1000, Number(args?.bridgeTimeoutMs ?? 5000)),
          bridgePollMs: Math.max(50, Number(args?.bridgePollMs ?? 250)),
          includeScreenshot: args?.includeScreenshot === true,
          includeRuntimeInspect: args?.includeRuntimeInspect !== false,
          includeLowLevelRuntimeChecks: args?.includeLowLevelRuntimeChecks !== false,
          includeLocalOsFallbackChecks: args?.includeLocalOsFallbackChecks !== false,
          includeLogTail: false
        });
      }
      return result;
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  const diagnostics = await runtimeDiagnostics({
    includeLogTail: true,
    logTailLines
  });
  const classification = classifyBridgeLoadWatch({
    diagnostics,
    lastStatus,
    lastLogEvidence
  });
  return {
    ok: false,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    reason: classification.reason,
    nextStep: classification.nextStep,
    recommendation: classification.recommendation,
    lastStatus,
    playerLog: lastLogEvidence,
    diagnostics,
    events
  };
}

function summarizeBridgeStatus(status) {
  if (!status) return null;
  if (!status.ok) {
    return { ok: false, command: status.command, error: status.error };
  }
  return {
    ok: true,
    bridge: status?.data?.bridge || status?.data?.Bridge,
    version: status?.data?.version || status?.data?.Version,
    dll: status?.data?.dll ?? status?.data?.Dll
  };
}

function classifyBridgeLoadWatch(state) {
  const diagnostics = state?.diagnostics || {};
  const logEvidence = state?.lastLogEvidence || diagnostics.playerLog || {};
  const freshness = diagnostics.bridgeArtifactFreshness;
  if (diagnostics.bridgeStatus?.ok || state?.lastStatus?.ok) {
    return {
      nextStep: "bridge_ready",
      reason: "The in-game bridge responded.",
      recommendation: "Run witch_takeover_audit or witch_verify_readiness, then start with dry-run takeover steps."
    };
  }
  if (!diagnostics.process?.running) {
    return {
      nextStep: "start_game",
      reason: "Timed out and no game process is running.",
      recommendation: "Start Witch's Apocalyptic Journey, then run witch_watch_bridge_load again."
    };
  }
  if (!logEvidence?.exists) {
    return {
      nextStep: "inspect_game_start",
      reason: "Timed out and Player.log was not found.",
      recommendation: "Confirm the game starts far enough to write Player.log."
    };
  }
  if (!logEvidence?.hasBridgeEvidence) {
    const processPredatesBridge = freshness?.processStartedBeforeNewestArtifact === true;
    return {
      nextStep: "restart_game_to_load_mod",
      reason: processPredatesBridge
        ? "Timed out with no CodexMcpBridge evidence in Player.log; the current game process predates the newest bridge artifact."
        : "Timed out with no CodexMcpBridge evidence in Player.log.",
      recommendation: "Restart the game so the installed CodexMcpBridge ModConfig.json and Entry.dll are discovered."
    };
  }
  return {
    nextStep: "inspect_player_log",
    reason: "Timed out even though Player.log contains CodexMcpBridge evidence.",
    recommendation: "Inspect playerLog.bridgeEvidence and recentModEvidence for loader or bridge startup errors."
  };
}

async function restartAndWatchBridge(args) {
  if (args?.confirm !== "RESTART_WITCH_GAME") {
    const diagnostics = await runtimeDiagnostics({ includeLogTail: false });
    return {
      ok: false,
      reason: "restart_confirmation_required",
      nextStep: "confirm_restart",
      recommendation: "Re-run witch_restart_and_watch_bridge with confirm:\"RESTART_WITCH_GAME\" to close/restart the game, watch bridge loading, and run takeover audit when ready.",
      diagnostics
    };
  }

  const gracefulCloseTimeoutMs = args?.gracefulCloseTimeoutMs ?? 8000;
  const steps = [];
  let diagnostics = await runtimeDiagnostics({ includeLogTail: false });
  steps.push({ name: "initial_diagnostics", result: diagnostics });

  if (diagnostics.process?.running) {
    const restart = await restartGameProcess(diagnostics.process.processes, { gracefulCloseTimeoutMs });
    steps.push({ name: "restart_game", result: restart });
    if (!restart.ok) {
      return {
        ok: false,
        reason: "restart_failed",
        steps,
        diagnostics,
        nextStep: "manual_restart",
        recommendation: "Restart the game manually, then run witch_watch_bridge_load."
      };
    }
  }

  const launch = await startGameProcess();
  steps.push({ name: "launch_game", result: launch });
  if (!launch.ok) {
    return {
      ok: false,
      reason: "launch_failed",
      steps,
      diagnostics,
      nextStep: "manual_start_game",
      recommendation: "Start the game manually, then run witch_watch_bridge_load."
    };
  }

  const watch = await watchBridgeLoad({
    timeoutMs: args?.timeoutMs ?? 120000,
    pollMs: args?.pollMs ?? 1000,
    logTailLines: args?.logTailLines ?? 120,
    runAuditWhenReady: args?.runAuditWhenReady !== false,
    includeScreenshot: args?.includeScreenshot === true,
    includeRuntimeInspect: args?.includeRuntimeInspect !== false,
    includeLowLevelRuntimeChecks: args?.includeLowLevelRuntimeChecks !== false,
    includeLocalOsFallbackChecks: args?.includeLocalOsFallbackChecks !== false
  });

  return {
    ok: watch?.ok === true,
    reason: watch?.ok ? "bridge_ready" : watch?.reason || "bridge_watch_failed",
    steps,
    watch,
    nextStep: watch?.nextStep,
    recommendation: watch?.recommendation
  };
}

async function verifyReadiness(args) {
  const checks = [];
  const result = {
    ok: false,
    capturedAtUtc: new Date().toISOString(),
    checks,
    artifacts: {}
  };

  const bridge = await waitForBridge({
    timeoutMs: args?.bridgeTimeoutMs ?? 30000,
    pollMs: args?.bridgePollMs ?? 500
  });
  result.artifacts.bridge = bridge;
  addCheck(checks, "bridge_reachable", bridge?.ok === true, bridge?.ok ? "Bridge status responded." : "Bridge did not respond before timeout.");
  if (!bridge?.ok) {
    result.reason = "bridge_unavailable";
    return result;
  }

  const policy = compactPolicyArgs(args || {});
  const snapshot = await collectGameSnapshot({ includeHidden: !!args?.includeHidden, onlyInteractive: args?.onlyInteractive !== false });
  result.artifacts.snapshot = snapshot;
  addCheck(checks, "game_snapshot", snapshot?.ok === true, snapshot?.ok ? "Status, UI, scene, and legal-action snapshots responded." : "Game snapshot failed.");

  if (args?.includeRuntimeInspect !== false) {
    const runtime = await safeCallBridge("runtime.inspect", {
      query: "RuntimeGameplayAutomationService",
      assembly: "Witch",
      maxTypes: 10,
      maxMembersPerType: 20
    });
    result.artifacts.runtimeInspect = runtime;
    const hasGameplayService = runtime?.ok === true && Array.isArray(runtime?.data?.types) && runtime.data.types.some(type => String(type.fullName || "").includes("RuntimeGameplayAutomationService"));
    addCheck(checks, "runtime_inspect", hasGameplayService, hasGameplayService ? "Runtime inspection found RuntimeGameplayAutomationService." : "Runtime inspection did not find the gameplay automation service.");
  }

  const summary = await collectStateSummary(policy);
  result.artifacts.summary = summary;
  addCheck(checks, "state_summary", summary?.ok === true, summary?.ok ? "Decision summary is available." : "Decision summary failed.");

  const plan = await planNext(args || {});
  result.artifacts.plan = plan;
  addCheck(checks, "plan_next", plan?.ok === true && !!plan?.recommendedCall, plan?.ok ? "Planner returned a recommended MCP call." : "Planner could not recommend an action.");

  if (args?.includeScreenshot !== false) {
    const screenshot = await captureAndWait({
      path: args?.screenshotPath,
      directory: args?.screenshotDirectory,
      timeoutMs: args?.screenshotTimeoutMs ?? 5000,
      pollMs: args?.screenshotPollMs ?? 100
    });
    result.artifacts.screenshot = screenshot;
    addCheck(checks, "screenshot_file", screenshot?.ok === true && screenshot?.sizeBytes > 0, screenshot?.ok ? "Screenshot file exists and is non-empty." : "Screenshot file was not confirmed.");
  }

  const takeover = await takeoverStep({
    ...args,
    dryRun: true,
    waitBridge: false,
    focusWindow: false,
    includeScreenshot: false,
    includePostSummary: false
  });
  result.artifacts.takeoverDryRun = takeover;
  addCheck(checks, "takeover_dry_run", takeover?.ok === true && takeover?.dryRun === true, takeover?.ok ? "Takeover dry-run can preview a next action." : "Takeover dry-run failed.");

  result.ok = checks.every(check => check.ok);
  result.reason = result.ok ? "ready" : "checks_failed";
  return result;
}

function addCheck(checks, name, ok, message) {
  checks.push({ name, ok: !!ok, message });
}

async function captureAndWait(args) {
  const timeoutMs = Math.max(0, Number(args?.timeoutMs ?? 5000));
  const pollMs = Math.max(25, Number(args?.pollMs ?? 100));
  const startedAt = Date.now();
  const capture = await callBridgeWithLocalFallback("screen.capture", {
    path: args?.path,
    directory: args?.directory
  });

  if (capture?.ok === false) {
    return { ok: false, capture, timedOut: false, waitedMs: Date.now() - startedAt };
  }

  const fullPath = capture?.data?.fullPath || capture?.data?.FullPath || capture?.data?.screenshotFullPath || capture?.data?.ScreenshotFullPath;
  if (!fullPath) {
    return { ok: false, capture, error: "screen.capture did not return a fullPath.", timedOut: false, waitedMs: Date.now() - startedAt };
  }

  let lastError = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && stat.size > 0) {
        return {
          ok: true,
          capture,
          fullPath,
          sizeBytes: stat.size,
          modifiedAtUtc: stat.mtime.toISOString(),
          timedOut: false,
          waitedMs: Date.now() - startedAt
        };
      }
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return {
    ok: false,
    capture,
    fullPath,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    lastError
  };
}

function localCapabilities() {
  return {
    ok: true,
    bridgeUrl: BRIDGE_URL,
    workspaceRoot: WORKSPACE_ROOT,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    noMouseDefault: DEFAULT_NO_MOUSE,
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description
    })),
    bridgeCommands: [
      "status",
      "ui.snapshot",
      "ui.interact",
      "ui.wait",
      "scene.snapshot",
      "scene.interact",
      "scene.raycast",
      "screen.info",
      "screen.capture",
      "window.focus",
      "input.key",
      "input.text",
      "input.mouse",
      "game.legal_actions",
      "game.perform_action",
      "battle.play_card",
      "runtime.inspect",
      "runtime.objects",
      "runtime.object_detail",
      "runtime.component_members",
      "runtime.component_call",
      "runtime.component_set",
      "runtime.invoke_static"
    ],
    uiActions: ["click", "double_click", "hover", "set_text", "submit", "scroll", "drag"],
    sceneActions: ["click", "hover", "drag", "scroll"],
    fallbackInputActions: ["focus", "key", "text", "mouse"],
    noMouseMode: {
      enabledByDefault: DEFAULT_NO_MOUSE,
      forbiddenCommands: ["input.mouse"],
      allowedNoMouseInteractionTools: [
        "witch_perform_action_match",
        "witch_auto_step",
        "witch_control_map",
        "witch_no_mouse_coverage",
        "witch_ui_interact",
        "witch_ui_click_label",
        "witch_scene_interact",
        "witch_runtime_component_call",
        "witch_runtime_component_set",
        "witch_runtime_invoke_static"
      ],
      override: "Set WITCH_JOURNEY_NO_MOUSE=0 or pass noMouse:false to witch_input_mouse only when OS mouse fallback is explicitly desired."
    },
    uiWaitConditions: ["node_exists", "window_exists", "text_contains", "layout_changed", "node_gone"],
    selectorStrategy: [
      "Prefer stable nodeId or instanceId from snapshots.",
      "Use windowName plus label or transformPath when IDs are not known.",
      "Use witch_runtime_diagnostics when the bridge is offline to inspect the game process, installed mod files, DLL markers, and Player.log evidence.",
      "Use witch_watch_bridge_load immediately after a manual or scripted restart to watch bridge status and Player.log evidence from MCP.",
      "Use witch_restart_and_watch_bridge only with confirm:\"RESTART_WITCH_GAME\" when Codex should close/restart the game and then watch the bridge load.",
      "Use witch_prepare_takeover to launch the game when absent, wait for the bridge, and run readiness checks before autonomous takeover.",
      "Use witch_verify_readiness after launching the game to prove observation, planning, screenshot, and takeover dry-run readiness.",
      "Use witch_takeover_audit for a requirement-style proof of local install state plus bridge-side takeover readiness.",
      "Use witch_legal_actions and witch_perform_action_match for explicit high-level gameplay actions.",
      "Use witch_state_summary for compact decision context before acting.",
      "Use witch_control_map when Codex needs every current legal/UI/scene operation mapped to no-mouse MCP calls, not just the recommended next step.",
      "Use witch_auto_step and witch_auto_drive for bounded autonomous play loops based only on game-reported legal actions.",
      "Use witch_batch to run bounded observe-plan-act sequences; it defaults to dry-run for action tools.",
      "Use witch_takeover_step for a single evidence-rich takeover loop that waits for the bridge, focuses the window, captures visual evidence, plans, and optionally acts.",
      "Use witch_takeover_drive for a bounded multi-step takeover loop after reviewing stop conditions.",
      "Use witch_window_focus before fallback input when focus is uncertain.",
      "No-mouse mode is enabled by default; use legal actions, UI automation, scene automation, and runtime tools instead of witch_input_mouse.",
      "Use witch_no_mouse_coverage to prove the running game has the required no-mouse runtime services and current control-map evidence.",
      "Use witch_input_key and witch_input_text only as fallback controls when typed game/UI/scene automation is insufficient. witch_input_mouse is refused unless noMouse is explicitly disabled.",
      "Use witch_runtime_inspect to discover loaded game automation/debug surfaces when typed tools do not cover a needed operation.",
      "Use witch_runtime_objects to inspect Unity GameObjects/components when UI, scene, or legal-action snapshots do not expose enough context.",
      "Use witch_runtime_object_detail to read public component properties/fields for one Unity object after locating it with witch_runtime_objects.",
      "Use witch_runtime_component_members to enumerate public component methods/properties/fields before deciding on a low-level operation.",
      "Use witch_runtime_component_call as a last-resort component method surface; keep dryRun true until the selected object, component, and method signature are reviewed.",
      "Use witch_runtime_component_set as a last-resort writable property/field surface; keep dryRun true until the selected object, component, member, and value are reviewed.",
      "Use witch_runtime_invoke_static only for reviewed public static methods; Witch.UI.Automation.* is allowed by default and other prefixes must be explicitly allowed."
    ]
  };
}

async function noMouseAudit(args) {
  const capabilities = localCapabilities();
  const policyTests = args?.includePolicyTests === false ? null : await runNoMousePolicyTests();
  const operationFamilies = noMouseOperationFamilies();
  const missingTools = [];
  for (const family of operationFamilies) {
    for (const toolName of family.tools) {
      if (!tools.some(tool => tool.name === toolName)) {
        missingTools.push({ family: family.name, tool: toolName });
      }
    }
  }

  let currentState = null;
  if (args?.includeCurrentState !== false) {
    currentState = await collectNoMouseCurrentState(args || {});
  }

  const checks = [
    {
      name: "default_no_mouse_enabled",
      ok: DEFAULT_NO_MOUSE === true,
      message: DEFAULT_NO_MOUSE ? "OS mouse fallback is disabled by default." : "OS mouse fallback is enabled by default."
    },
    {
      name: "mouse_entry_points_refused",
      ok: policyTests ? policyTests.ok === true : true,
      message: policyTests ? "Direct, escape-hatch, and batch mouse entry points were checked." : "Policy tests skipped by request."
    },
    {
      name: "operation_family_tools_present",
      ok: missingTools.length === 0,
      message: missingTools.length === 0 ? "All declared no-mouse operation families have their MCP tools present." : "One or more no-mouse operation families are missing tools."
    },
    {
      name: "current_state_has_no_mouse_path_or_is_observable",
      ok: currentState ? currentState.ok === true : true,
      message: currentState ? currentState.message : "Current-state inspection skipped by request."
    }
  ];

  return {
    ok: checks.every(check => check.ok),
    capturedAtUtc: new Date().toISOString(),
    noMouseDefault: DEFAULT_NO_MOUSE,
    bridgeUrl: BRIDGE_URL,
    workspaceRoot: WORKSPACE_ROOT,
    checks,
    operationFamilies,
    policyTests,
    currentState,
    capabilities: {
      toolCount: capabilities.tools.length,
      noMouseMode: capabilities.noMouseMode
    }
  };
}

async function noMouseCoverage(args) {
  const capabilities = localCapabilities();
  const toolNames = new Set(capabilities.tools.map(tool => tool.name));
  const bridgeCommands = new Set(capabilities.bridgeCommands || []);
  const policyTests = args?.includePolicyTests === false ? null : await runNoMousePolicyTests();
  const runtimeServices = await inspectNoMouseRuntimeServices();
  const currentState = args?.includeCurrentState === false ? null : await collectNoMouseCurrentState(args || {});
  const families = noMouseCoverageFamilies(runtimeServices, currentState);

  const checks = [
    {
      name: "default_no_mouse_enabled",
      ok: DEFAULT_NO_MOUSE === true,
      message: DEFAULT_NO_MOUSE ? "OS mouse fallback is disabled by default." : "OS mouse fallback is enabled by default."
    },
    {
      name: "mouse_entry_points_refused",
      ok: policyTests ? policyTests.ok === true : true,
      message: policyTests ? "Direct, escape-hatch, and batch mouse entry points were checked." : "Policy tests skipped by request."
    },
    {
      name: "mcp_tools_present",
      ok: families.every(family => family.requiredTools.every(tool => toolNames.has(tool))),
      message: "Required no-mouse MCP tools were checked against the local tool list."
    },
    {
      name: "bridge_commands_present",
      ok: families.every(family => family.bridgeCommands.every(command => bridgeCommands.has(command))),
      message: "Required bridge commands were checked against the local capability declaration."
    },
    {
      name: "runtime_services_present",
      ok: families.every(family => family.runtime.ok),
      message: "Runtime automation services and methods were inspected in the running game."
    },
    {
      name: "current_state_mapped_or_skipped",
      ok: currentState ? currentState.ok === true : true,
      message: currentState ? currentState.message : "Current-state control-map inspection skipped by request."
    }
  ];

  return {
    ok: checks.every(check => check.ok),
    capturedAtUtc: new Date().toISOString(),
    noMouseDefault: DEFAULT_NO_MOUSE,
    bridgeUrl: BRIDGE_URL,
    workspaceRoot: WORKSPACE_ROOT,
    checks,
    families,
    runtimeServices,
    currentState,
    policyTests,
    capabilities: {
      toolCount: capabilities.tools.length,
      bridgeCommandCount: capabilities.bridgeCommands.length,
      noMouseMode: capabilities.noMouseMode
    }
  };
}

async function inspectNoMouseRuntimeServices() {
  const specs = [
    {
      key: "gameplay",
      typeName: "Witch.UI.Automation.RuntimeGameplayAutomationService",
      query: "RuntimeGameplayAutomationService",
      requiredMethods: ["GetLegalActions", "PerformActionAsync"]
    },
    {
      key: "ui",
      typeName: "Witch.UI.Automation.RuntimeUiAutomationService",
      query: "RuntimeUiAutomationService",
      requiredMethods: ["CaptureSnapshot", "EvaluateWaitCondition", "InteractAsync"]
    },
    {
      key: "scene",
      typeName: "Witch.UI.Automation.RuntimeSceneAutomationService",
      query: "RuntimeSceneAutomationService",
      requiredMethods: ["CaptureSnapshot", "Raycast", "InteractAsync"]
    },
    {
      key: "battle",
      typeName: "Witch.UI.Automation.RuntimeBattleAutomationService",
      query: "RuntimeBattleAutomationService",
      requiredMethods: ["PlayCardAsync"]
    }
  ];

  const entries = {};
  await Promise.all(specs.map(async spec => {
    const inspect = await safeCallBridge("runtime.inspect", {
      query: spec.query,
      assembly: "Witch",
      maxTypes: 20,
      maxMembersPerType: 120
    });
    const service = runtimeServiceEvidence(inspect, spec);
    entries[spec.key] = service;
  }));
  return entries;
}

function runtimeServiceEvidence(inspect, spec) {
  const types = Array.isArray(inspect?.data?.types) ? inspect.data.types : [];
  const type = types.find(item => item.fullName === spec.typeName) || types.find(item => String(item.fullName || "").endsWith("." + spec.query));
  const methodNames = new Set((type?.members || [])
    .filter(member => member.kind === "method")
    .map(member => member.name));
  const missingMethods = spec.requiredMethods.filter(name => !methodNames.has(name));
  return {
    ok: inspect?.ok === true && !!type && missingMethods.length === 0,
    key: spec.key,
    typeName: spec.typeName,
    requiredMethods: spec.requiredMethods,
    missingMethods,
    foundType: type ? {
      assembly: type.assembly,
      fullName: type.fullName,
      isPublic: type.isPublic,
      isStatic: type.isStatic,
      methodCount: methodNames.size
    } : null,
    inspect: inspect?.ok === true ? {
      ok: true,
      truncated: inspect.data?.truncated === true,
      typeCount: types.length
    } : inspect
  };
}

function noMouseCoverageFamilies(runtimeServices, currentState) {
  const byFamily = currentState?.controlMap?.byFamily || {};
  return [
    {
      name: "high_level_gameplay",
      requiredTools: ["witch_legal_actions", "witch_perform_action", "witch_perform_action_match", "witch_auto_step", "witch_auto_drive"],
      bridgeCommands: ["game.legal_actions", "game.perform_action"],
      runtime: runtimeServices.gameplay,
      currentMappedOperations: byFamily.legal_action || 0,
      noMousePath: "game legal-action automation"
    },
    {
      name: "ui_operations",
      requiredTools: ["witch_ui_snapshot", "witch_ui_interact", "witch_ui_click_label", "witch_ui_wait", "witch_control_map"],
      bridgeCommands: ["ui.snapshot", "ui.interact", "ui.wait"],
      runtime: runtimeServices.ui,
      currentMappedOperations: byFamily.ui || 0,
      noMousePath: "Unity UI automation"
    },
    {
      name: "scene_operations",
      requiredTools: ["witch_scene_snapshot", "witch_scene_interact", "witch_scene_raycast", "witch_control_map"],
      bridgeCommands: ["scene.snapshot", "scene.interact", "scene.raycast"],
      runtime: runtimeServices.scene,
      currentMappedOperations: byFamily.scene || 0,
      noMousePath: "Unity scene automation"
    },
    {
      name: "battle_card_operations",
      requiredTools: ["witch_play_card"],
      bridgeCommands: ["battle.play_card"],
      runtime: runtimeServices.battle,
      currentMappedOperations: byFamily.battle || 0,
      noMousePath: "battle card automation"
    }
  ];
}

function noMouseOperationFamilies() {
  return [
    {
      name: "high_level_gameplay",
      noMouse: true,
      tools: ["witch_legal_actions", "witch_perform_action_match", "witch_auto_step", "witch_auto_drive"],
      bridgeCommands: ["game.legal_actions", "game.perform_action"],
      evidence: "Uses Witch.UI.Automation.RuntimeGameplayAutomationService instead of OS mouse input."
    },
    {
      name: "ui_operations",
      noMouse: true,
      tools: ["witch_ui_snapshot", "witch_ui_interact", "witch_ui_click_label", "witch_ui_wait"],
      bridgeCommands: ["ui.snapshot", "ui.interact", "ui.wait"],
      evidence: "Uses Witch.UI.Automation.RuntimeUiAutomationService; click/double_click are Unity UI automation actions, not Windows mouse events."
    },
    {
      name: "scene_operations",
      noMouse: true,
      tools: ["witch_scene_snapshot", "witch_scene_interact", "witch_scene_raycast"],
      bridgeCommands: ["scene.snapshot", "scene.interact", "scene.raycast"],
      evidence: "Uses Witch.UI.Automation.RuntimeSceneAutomationService; scene click/drag/hover are in-game automation actions."
    },
    {
      name: "battle_card_operations",
      noMouse: true,
      tools: ["witch_play_card"],
      bridgeCommands: ["battle.play_card"],
      evidence: "Uses Witch.UI.Automation.RuntimeBattleAutomationService by card id, instance id, hand index, and optional target selectors."
    },
    {
      name: "runtime_control",
      noMouse: true,
      tools: [
        "witch_runtime_inspect",
        "witch_runtime_objects",
        "witch_runtime_object_detail",
        "witch_runtime_component_members",
        "witch_runtime_component_call",
        "witch_runtime_component_set",
        "witch_runtime_invoke_static"
      ],
      bridgeCommands: [
        "runtime.inspect",
        "runtime.objects",
        "runtime.object_detail",
        "runtime.component_members",
        "runtime.component_call",
        "runtime.component_set",
        "runtime.invoke_static"
      ],
      evidence: "Uses in-process reflection/runtime automation, with dry-run defaults and confirmation gates for writes/calls."
    },
    {
      name: "observation_and_planning",
      noMouse: true,
      tools: [
        "witch_game_snapshot",
        "witch_control_map",
        "witch_no_mouse_coverage",
        "witch_state_summary",
        "witch_plan_next",
        "witch_execute_plan",
        "witch_takeover_step",
        "witch_takeover_drive",
        "witch_find_targets",
        "witch_batch"
      ],
      bridgeCommands: ["status", "screen.info", "screen.capture"],
      evidence: "Observation, screenshots, summaries, planning, and batch execution do not require OS mouse input; planned mouse calls are refused by policy."
    },
    {
      name: "forbidden_os_mouse_fallback",
      noMouse: false,
      tools: ["witch_input_mouse", "witch_bridge_command"],
      bridgeCommands: ["input.mouse"],
      evidence: "Present for explicit fallback compatibility, but refused by default through no-mouse policy."
    }
  ];
}

async function runNoMousePolicyTests() {
  const direct = await callBridgeWithLocalFallback("input.mouse", { action: "click", x: 10, y: 10 });
  const escape = await callBridgeWithLocalFallback("input.mouse", { action: "click", x: 20, y: 20, noMouse: true });
  const batch = await runBatch({
    dryRun: false,
    steps: [
      { tool: "witch_input_mouse", arguments: { action: "click", x: 30, y: 30 } }
    ]
  });
  const results = { direct, escape, batch };
  const ok = direct?.reason === "mouse_forbidden"
    && escape?.reason === "mouse_forbidden"
    && batch?.results?.[0]?.result?.reason === "mouse_forbidden";
  return { ok, results };
}

async function collectNoMouseCurrentState(args) {
  const [summary, controlMap] = await Promise.all([
    collectStateSummary({
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    }),
    collectControlMap({
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    })
  ]);
  if (!summary.ok) {
    return {
      ok: false,
      message: "Current state could not be summarized.",
      summary,
      controlMap
    };
  }
  const legalCount = Number(summary.legalActions?.count || 0);
  const uiCount = Number(summary.ui?.clickableNodes?.length || 0);
  const sceneCount = Number(summary.scene?.objects?.length || 0);
  const mappedOperationCount = Number(controlMap?.operationCount || 0);
  const hasNoMousePath = mappedOperationCount > 0 || legalCount > 0 || uiCount > 0 || sceneCount > 0;
  return {
    ok: true,
    message: hasNoMousePath
      ? "Current state exposes at least one no-mouse action path."
      : "Current state is observable, but no legal action, UI affordance, scene affordance, or mapped operation is currently exposed.",
    hasNoMousePath,
    legalActionCount: legalCount,
    clickableUiCount: uiCount,
    interactiveSceneObjectCount: sceneCount,
    mappedOperationCount,
    readyMappedOperationCount: Number(controlMap?.readyOperationCount || 0),
    unmappedCount: Number(controlMap?.unmappedCount || 0),
    recommendedCall: summary.suggestedNextAction
      ? { tool: "witch_perform_action_match", arguments: { actionId: summary.suggestedNextAction.id, contains: false } }
      : (controlMap?.operations?.[0]?.call || (uiCount > 0
        ? { tool: "witch_ui_interact", arguments: { action: "click", selector: compactUiSelector(summary.ui.clickableNodes[0]) } }
        : (sceneCount > 0
          ? { tool: "witch_scene_interact", arguments: { action: "click", selector: compactSceneSelector(summary.scene.objects[0]) } }
          : null))),
    summary: {
      capturedAtUtc: summary.capturedAtUtc,
      phase: summary.legalActions?.phase,
      activeWindows: summary.ui?.activeWindows,
      sceneName: summary.scene?.sceneName
    },
    controlMap: controlMap?.ok ? {
      operationCount: controlMap.operationCount,
      readyOperationCount: controlMap.readyOperationCount,
      unmappedCount: controlMap.unmappedCount,
      byFamily: controlMap.byFamily
    } : controlMap
  };
}

async function runtimeDiagnostics(args) {
  const includeLogTail = args?.includeLogTail === true;
  const logTailLines = clampInt(args?.logTailLines, 120, 20, 500);
  const modRoots = [
    path.join(WORKSPACE_ROOT, "Witch's Apocalyptic Journey_Data", "Mods", "CodexMcpBridge"),
    path.join(WORKSPACE_ROOT, "Mods", "CodexMcpBridge")
  ];
  const modFiles = [];

  for (const root of modRoots) {
    const rootInfo = await statInfo(root);
    const modConfigPath = path.join(root, "ModConfig.json");
    const dllPath = path.join(root, "Scripts", "Entry.dll");
    const luaPath = path.join(root, "Scripts", "Entry.lua");
    const disabledLuaPath = path.join(root, "Scripts", "Entry.lua.disabled");
    const devSourcePath = path.join(root, "Dev", "Entry.cs");
    const modConfig = await statInfo(modConfigPath);
    const dll = await statInfo(dllPath);
    const lua = await statInfo(luaPath);
    const disabledLua = await statInfo(disabledLuaPath);
    const devSource = await statInfo(devSourcePath);
    const modConfigJson = modConfig.exists ? await readJsonFile(modConfigPath) : null;
    const iconPath = modConfigJson?.ok && modConfigJson.data?.IconPath ? path.join(root, String(modConfigJson.data.IconPath)) : path.join(root, "Icon.png");
    const icon = await statInfo(iconPath);
    const manifestChecks = modConfigJson?.ok ? buildManifestChecks(modConfigJson.data, icon) : { ok: false, error: modConfigJson?.error || "ModConfig.json missing" };
    const markers = dll.exists ? await scanFileMarkers(dllPath, BRIDGE_MARKERS) : {};
    modFiles.push({
      root,
      exists: rootInfo.exists,
      modConfig,
      modConfigJson,
      icon,
      manifestChecks,
      dll,
      scriptEntries: {
        entryDll: dll,
        entryLua: lua,
        disabledLua,
        dllOnly: dll.exists === true && lua.exists !== true
      },
      devSource,
      dllMarkers: markers
    });
  }

  const logEvidence = await inspectPlayerLog(includeLogTail, logTailLines);
  const processInfo = await inspectGameProcess();
  const bridgeStatus = await safeCallBridge("status", {});
  const bridgeArtifactFreshness = compareBridgeArtifactFreshness(modFiles, processInfo);
  const classification = classifyRuntimeState({ modFiles, logEvidence, processInfo, bridgeStatus, bridgeArtifactFreshness });

  return {
    ok: true,
    capturedAtUtc: new Date().toISOString(),
    bridgeUrl: BRIDGE_URL,
    workspaceRoot: WORKSPACE_ROOT,
    bridgeStatus,
    process: processInfo,
    bridgeArtifactFreshness,
    modFiles,
    playerLog: logEvidence,
    nextStep: classification.nextStep,
    reason: classification.reason,
    recommendation: classification.recommendation
  };
}

async function takeoverAudit(args) {
  const diagnostics = await runtimeDiagnostics({
    includeLogTail: args?.includeLogTail === true,
    logTailLines: args?.logTailLines ?? 120
  });
  const capabilities = localCapabilities();
  const requirements = [];
  const artifacts = { diagnostics, capabilities };

  const expectedTools = [
    "witch_status",
    "witch_wait_bridge",
    "witch_runtime_diagnostics",
    "witch_watch_bridge_load",
    "witch_restart_and_watch_bridge",
    "witch_prepare_takeover",
    "witch_verify_readiness",
    "witch_takeover_audit",
    "witch_no_mouse_audit",
    "witch_no_mouse_coverage",
    "witch_takeover_step",
    "witch_takeover_drive",
    "witch_game_snapshot",
    "witch_control_map",
    "witch_state_summary",
    "witch_plan_next",
    "witch_execute_plan",
    "witch_find_targets",
    "witch_batch",
    "witch_capabilities",
    "witch_ui_snapshot",
    "witch_ui_interact",
    "witch_ui_click_label",
    "witch_ui_wait",
    "witch_scene_snapshot",
    "witch_scene_interact",
    "witch_scene_raycast",
    "witch_screen_info",
    "witch_screen_capture",
    "witch_screen_capture_wait",
    "witch_window_focus",
    "witch_input_key",
    "witch_input_text",
    "witch_input_mouse",
    "witch_legal_actions",
    "witch_perform_action",
    "witch_perform_action_match",
    "witch_play_card",
    "witch_auto_step",
    "witch_auto_drive",
    "witch_runtime_inspect",
    "witch_runtime_objects",
    "witch_runtime_object_detail",
    "witch_runtime_component_members",
    "witch_runtime_component_call",
    "witch_runtime_component_set",
    "witch_runtime_invoke_static",
    "witch_bridge_command"
  ];
  const toolNames = new Set(tools.map(tool => tool.name));
  const missingTools = expectedTools.filter(name => !toolNames.has(name));

  const modRootsReady = diagnostics.modFiles.filter(root => root.exists && root.modConfig?.exists && root.dll?.exists);
  const markerReady = diagnostics.modFiles.some(root => root.dll?.exists && BRIDGE_MARKERS.every(marker => root.dllMarkers?.[marker] === true));
  addRequirement(requirements, "mcp_tool_surface", missingTools.length === 0, missingTools.length === 0 ? "MCP exposes all expected takeover, observation, fallback, and runtime tools." : "Missing MCP tools: " + missingTools.join(", "), { expected: expectedTools.length, actual: tools.length, missing: missingTools });
  addRequirement(requirements, "bridge_mod_installed", modRootsReady.length > 0, modRootsReady.length > 0 ? "CodexMcpBridge ModConfig.json and Entry.dll exist in at least one mod root." : "No complete CodexMcpBridge mod root was found.", modRootsReady.map(root => root.root));
  addRequirement(requirements, "bridge_dll_markers", markerReady, markerReady ? "Entry.dll contains the expected version and command markers." : "Entry.dll is missing one or more expected markers.", BRIDGE_MARKERS);
  addRequirement(requirements, "game_process", diagnostics.process?.running === true, diagnostics.process?.running ? "The game process is running." : "No game process is running.", diagnostics.process);
  addRequirement(requirements, "bridge_reachable", diagnostics.bridgeStatus?.ok === true, diagnostics.bridgeStatus?.ok ? "The in-game bridge responded." : "The in-game bridge is not reachable yet.", diagnostics.bridgeStatus);

  if (args?.includeLocalOsFallbackChecks !== false) {
    const localOsFallback = await verifyLocalOsFallbackControl(args || {});
    artifacts.localOsFallback = localOsFallback;
    addRequirement(
      requirements,
      "local_os_fallback_control",
      localOsFallback?.ok === true,
      localOsFallback?.ok ? "Local OS fallback can inspect, focus, and capture the current game window while the in-game bridge is offline." : "Local OS fallback control checks failed.",
      localOsFallback?.checks || []
    );
  }

  let readiness = null;
  if (diagnostics.bridgeStatus?.ok) {
    readiness = await verifyReadiness({
      bridgeTimeoutMs: args?.bridgeTimeoutMs ?? 30000,
      bridgePollMs: args?.bridgePollMs ?? 500,
      includeScreenshot: args?.includeScreenshot !== false,
      screenshotPath: args?.screenshotPath,
      screenshotDirectory: args?.screenshotDirectory,
      screenshotTimeoutMs: args?.screenshotTimeoutMs ?? 5000,
      screenshotPollMs: args?.screenshotPollMs ?? 100,
      includeRuntimeInspect: args?.includeRuntimeInspect !== false,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
    artifacts.readiness = readiness;
    addRequirement(requirements, "readiness_checks", readiness?.ok === true, readiness?.ok ? "Readiness checks passed." : "One or more readiness checks failed.", readiness?.checks || []);

    if (args?.includeLowLevelRuntimeChecks !== false) {
      const lowLevel = await runBatch({
        dryRun: true,
        stopOnError: false,
        steps: [
          { tool: "witch_runtime_inspect", arguments: { query: "RuntimeGameplayAutomationService", assembly: "Witch", maxTypes: 10, maxMembersPerType: 20 } },
          { tool: "witch_runtime_objects", arguments: { query: "Camera", componentType: "Camera", maxObjects: 10 } },
          { tool: "witch_runtime_object_detail", arguments: { query: "Camera", componentType: "Camera", maxMembersPerComponent: 20 } },
          { tool: "witch_runtime_component_members", arguments: { query: "Camera", componentType: "Camera", memberQuery: "field", includeValues: false, maxMembersPerComponent: 30 } },
          { tool: "witch_runtime_component_call", arguments: { query: "Camera", componentType: "Camera", methodName: "GetInstanceID" } },
          { tool: "witch_runtime_component_set", arguments: { query: "Camera", componentType: "Camera", memberName: "fieldOfView", value: 60 } }
        ]
      });
      artifacts.lowLevelRuntimeChecks = lowLevel;
      addRequirement(requirements, "low_level_runtime_fallbacks", lowLevel?.ok === true, lowLevel?.ok ? "Runtime discovery, component inspection, dry-run method call, and dry-run member set paths responded." : "One or more low-level runtime fallback checks failed.", lowLevel?.results || []);
    }
  } else {
    addRequirement(requirements, "readiness_checks", false, "Skipped because the bridge is not reachable.", null);
    addRequirement(requirements, "low_level_runtime_fallbacks", false, "Skipped because the bridge is not reachable.", null);
  }

  const ok = requirements.every(item => item.ok);
  return {
    ok,
    capturedAtUtc: new Date().toISOString(),
    reason: ok ? "takeover_ready" : "requirements_not_met",
    nextStep: ok ? "start_dry_run_takeover" : diagnostics.nextStep,
    recommendation: ok ? "Use witch_takeover_step or witch_takeover_drive with dryRun:true first, then execute bounded non-dry-run steps after reviewing the recommended call." : diagnostics.recommendation,
    requirements,
    artifacts
  };
}

function addRequirement(requirements, name, ok, message, evidence) {
  requirements.push({ name, ok: !!ok, message, evidence });
}

async function verifyLocalOsFallbackControl(args) {
  const checks = [];
  const artifacts = {};
  const screenshotPath = args?.localOsScreenshotPath || path.join(os.tmpdir(), `witch-local-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);

  const screenInfo = await safeCallBridge("screen.info", {});
  artifacts.screenInfo = screenInfo;
  const hasWindow = screenInfo?.ok === true && !!(screenInfo?.data?.activeWindow || screenInfo?.data?.windowRect);
  addCheck(checks, "local_screen_info", hasWindow, hasWindow ? "Local fallback returned a game window handle/rectangle." : "Local fallback did not return a usable game window.");

  const focus = await safeCallBridge("window.focus", {});
  artifacts.focus = focus;
  const focused = focus?.ok === true && focus?.data?.isForeground === true;
  const restored = focus?.ok === true && focus?.data?.requestedWindow && focus?.data?.restored === true;
  addCheck(checks, "local_window_focus", focused || restored, focused ? "Local fallback focused the game window." : restored ? "Local fallback restored the game window but Windows did not grant foreground focus." : "Local fallback could not focus or restore the game window.");

  const screenshot = await captureAndWait({
    path: screenshotPath,
    timeoutMs: args?.localOsScreenshotTimeoutMs ?? 3000,
    pollMs: args?.localOsScreenshotPollMs ?? 100
  });
  artifacts.screenshot = screenshot;
  addCheck(checks, "local_screen_capture", screenshot?.ok === true && screenshot?.sizeBytes > 0, screenshot?.ok ? "Local fallback captured a non-empty game-window PNG." : "Local fallback screenshot failed.");

  const inputSurface = [
    "witch_window_focus",
    "witch_input_key",
    "witch_input_text"
  ].every(name => tools.some(tool => tool.name === name));
  addCheck(checks, "local_input_tool_surface", inputSurface, inputSurface ? "Non-mouse fallback input tools are exposed through MCP." : "One or more non-mouse fallback input tools are missing from MCP.");
  addCheck(checks, "no_mouse_policy", DEFAULT_NO_MOUSE === true, DEFAULT_NO_MOUSE ? "OS mouse fallback is disabled by default." : "OS mouse fallback is not disabled by default.");

  return {
    ok: checks.every(check => check.ok),
    screenshotPath,
    checks,
    artifacts
  };
}

async function prepareTakeover(args) {
  const launchIfNotRunning = args?.launchIfNotRunning !== false;
  const restartIfRunning = args?.restartIfRunning === true;
  const gracefulCloseTimeoutMs = args?.gracefulCloseTimeoutMs ?? 8000;
  const waitBridgeEnabled = args?.waitBridge !== false;
  const bridgeTimeoutMs = args?.bridgeTimeoutMs ?? 60000;
  const bridgePollMs = args?.bridgePollMs ?? 500;
  const steps = [];
  let startedOrRestarted = false;

  let diagnostics = await runtimeDiagnostics({ includeLogTail: false });
  steps.push({ name: "initial_diagnostics", result: diagnostics });

  if (diagnostics.bridgeStatus?.ok && !restartIfRunning) {
    return finalizePrepareTakeover("bridge_ready", args, diagnostics, steps);
  }

  if (diagnostics.process?.running && !restartIfRunning) {
    return {
      ok: false,
      reason: "restart_required",
      nextStep: diagnostics.nextStep,
      recommendation: diagnostics.recommendation,
      diagnostics,
      steps
    };
  }

  if (diagnostics.process?.running && restartIfRunning) {
    if (args?.confirm !== "RESTART_WITCH_GAME") {
      return {
        ok: false,
        reason: "restart_confirmation_required",
        nextStep: "confirm_restart",
        recommendation: "Re-run witch_prepare_takeover with restartIfRunning:true and confirm:\"RESTART_WITCH_GAME\" to close the old game process, start the game, wait for the bridge, and verify readiness.",
        diagnostics,
        steps
      };
    }

    const restart = await restartGameProcess(diagnostics.process.processes, { gracefulCloseTimeoutMs });
    steps.push({ name: "restart_game", result: restart });
    if (!restart.ok) {
      return {
        ok: false,
        reason: "restart_failed",
        recommendation: "Restart the game manually, then run witch_prepare_takeover again.",
        diagnostics,
        steps
      };
    }
    startedOrRestarted = true;
  }

  if ((!diagnostics.process?.running || (diagnostics.process?.running && restartIfRunning)) && launchIfNotRunning) {
    const launch = await startGameProcess();
    steps.push({ name: "launch_game", result: launch });
    if (!launch.ok) {
      return {
        ok: false,
        reason: "launch_failed",
        recommendation: "Start the game manually, then run witch_prepare_takeover again.",
        diagnostics,
        steps
      };
    }
    startedOrRestarted = true;
  }

  if (waitBridgeEnabled) {
    const bridge = await waitForBridge({ timeoutMs: bridgeTimeoutMs, pollMs: bridgePollMs });
    steps.push({ name: "wait_bridge", result: bridge });
  }

  diagnostics = await runtimeDiagnostics({ includeLogTail: false });
  steps.push({ name: "post_wait_diagnostics", result: diagnostics });
  if (!waitBridgeEnabled && args?.runReadiness === false && startedOrRestarted) {
    return {
      ok: true,
      reason: diagnostics.bridgeStatus?.ok ? "bridge_ready" : "game_started_bridge_not_waited",
      nextStep: diagnostics.bridgeStatus?.ok ? "start_dry_run_takeover" : "wait_bridge",
      recommendation: diagnostics.bridgeStatus?.ok
        ? "Run witch_verify_readiness, then use witch_takeover_step or witch_takeover_drive with dryRun first."
        : "Wait for the bridge with witch_wait_bridge or wait-and-verify.ps1 before takeover.",
      diagnostics,
      steps
    };
  }
  if (!diagnostics.bridgeStatus?.ok) {
    return {
      ok: false,
      reason: diagnostics.nextStep === "bridge_ready" ? "bridge_unavailable" : diagnostics.nextStep,
      nextStep: diagnostics.nextStep,
      recommendation: diagnostics.recommendation,
      diagnostics,
      steps
    };
  }

  return finalizePrepareTakeover("bridge_ready", args, diagnostics, steps);
}

async function finalizePrepareTakeover(reason, args, diagnostics, steps) {
  if (args?.runReadiness === false) {
    return {
      ok: true,
      reason,
      diagnostics,
      steps
    };
  }

  const readiness = await verifyReadiness({
    bridgeTimeoutMs: args?.bridgeTimeoutMs ?? 30000,
    bridgePollMs: args?.bridgePollMs ?? 500,
    includeScreenshot: args?.includeScreenshot !== false,
    includeRuntimeInspect: args?.includeRuntimeInspect !== false
  });
  steps.push({ name: "verify_readiness", result: readiness });
  return {
    ok: readiness.ok === true,
    reason: readiness.ok ? "ready" : "readiness_failed",
    diagnostics,
    readiness,
    steps
  };
}

async function startGameProcess() {
  const exePath = path.join(WORKSPACE_ROOT, "Witch's Apocalyptic Journey.exe");
  const info = await statInfo(exePath);
  if (!info.exists) {
    return { ok: false, exePath, error: "Game executable was not found." };
  }

  try {
    const env = {
      ...process.env,
      CODEX_WITCH_EXE_PATH: exePath,
      CODEX_WITCH_WORKSPACE_ROOT: WORKSPACE_ROOT
    };
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      "$p = Start-Process -FilePath $env:CODEX_WITCH_EXE_PATH -WorkingDirectory $env:CODEX_WITCH_WORKSPACE_ROOT -PassThru -WindowStyle Normal; $p | Select-Object Id,ProcessName,StartTime,Path | ConvertTo-Json -Compress"
    ], { timeout: 10000, env });
    const startedProcess = JSON.parse(String(stdout || "{}").trim() || "{}");
    return {
      ok: true,
      exePath,
      process: startedProcess
    };
  } catch (error) {
    return {
      ok: false,
      exePath,
      error: String(error?.message || error),
      stdout: error?.stdout ? String(error.stdout) : undefined,
      stderr: error?.stderr ? String(error.stderr) : undefined
    };
  }
}

async function restartGameProcess(processes, options) {
  const targets = Array.isArray(processes) ? processes : [];
  if (targets.length === 0) {
    return { ok: true, stopped: [], reason: "no_processes" };
  }

  const stopped = [];
  for (const processInfo of targets) {
    const id = Number(processInfo.Id ?? processInfo.id);
    const processName = String(processInfo.ProcessName ?? processInfo.processName ?? "");
    if (!Number.isFinite(id) || !isGameProcessName(processName)) {
      return {
        ok: false,
        error: "Refusing to stop a process that does not match the game process name.",
        process: processInfo
      };
    }

    const result = await stopProcessById(id, options);
    stopped.push({ id, processName, result });
    if (!result.ok) {
      return { ok: false, stopped, error: result.error || "Failed to stop game process." };
    }
  }

  return { ok: true, stopped };
}

async function stopProcessById(pid, options) {
  const timeoutMs = Math.max(1000, Number(options?.gracefulCloseTimeoutMs ?? 8000));
  const command = "$targetPid = [int]$env:CODEX_WITCH_PID;" +
    "$timeoutMs = [int]$env:CODEX_WITCH_STOP_TIMEOUT_MS;" +
    "$p = Get-Process -Id $targetPid -ErrorAction Stop;" +
    "$closed = $false;" +
    "if ($p.MainWindowHandle -ne 0) { $closed = $p.CloseMainWindow(); }" +
    "$exited = $p.WaitForExit($timeoutMs);" +
    "if (-not $exited) { Stop-Process -Id $targetPid -Force -ErrorAction Stop; $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue; $exited = ($null -eq $p); }" +
    "[pscustomobject]@{ closed=$closed; exited=$exited; pid=$targetPid } | ConvertTo-Json -Compress";
  try {
    const env = {
      ...process.env,
      CODEX_WITCH_PID: String(pid),
      CODEX_WITCH_STOP_TIMEOUT_MS: String(timeoutMs)
    };
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], { timeout: timeoutMs + 5000, env });
    const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
    return { ok: parsed.exited === true || parsed.exited === "True", ...parsed };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      stdout: error?.stdout ? String(error.stdout) : undefined,
      stderr: error?.stderr ? String(error.stderr) : undefined
    };
  }
}

function isGameProcessName(processName) {
  return processName === "Witch's Apocalyptic Journey" || processName === "Witch's Apocalyptic Journey.exe";
}

async function statInfo(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      exists: true,
      type: stat.isDirectory() ? "directory" : "file",
      sizeBytes: stat.size,
      modifiedAtUtc: stat.mtime.toISOString()
    };
  } catch (error) {
    return {
      path: filePath,
      exists: false,
      error: String(error?.code || error?.message || error)
    };
  }
}

async function readJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, data: JSON.parse(text.replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function buildManifestChecks(config, icon) {
  const checks = [
    ["ModName", typeof config?.ModName === "string" && config.ModName.trim() !== ""],
    ["ModVersion", typeof config?.ModVersion === "string" && config.ModVersion.trim() !== ""],
    ["ModAuthor", typeof config?.ModAuthor === "string" && config.ModAuthor.trim() !== ""],
    ["ModDescription", typeof config?.ModDescription === "string" && config.ModDescription.trim() !== ""],
    ["IconPath", typeof config?.IconPath === "string" && config.IconPath.trim() !== ""],
    ["Enabled", config?.Enabled === true],
    ["Dependencies", Object.prototype.hasOwnProperty.call(config || {}, "Dependencies")],
    ["WorkshopVisibility", typeof config?.WorkshopVisibility === "string" && config.WorkshopVisibility.trim() !== ""],
    ["PublishedFileId", Object.prototype.hasOwnProperty.call(config || {}, "PublishedFileId")],
    ["MustSame", config?.MustSame === true],
    ["IconFile", icon?.exists === true && icon?.type === "file"]
  ].map(([name, ok]) => ({ name, ok: !!ok }));
  return { ok: checks.every(check => check.ok), checks };
}

async function scanFileMarkers(filePath, markers) {
  try {
    const buffer = await fs.readFile(filePath);
    const result = {};
    for (const marker of markers) {
      result[marker] = bufferIncludesString(buffer, marker);
    }
    return result;
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

function bufferIncludesString(buffer, value) {
  return buffer.includes(Buffer.from(value, "utf8")) || buffer.includes(Buffer.from(value, "utf16le"));
}

async function inspectPlayerLog(includeTail, tailLines) {
  const info = await statInfo(PLAYER_LOG_PATH);
  if (!info.exists) {
    return {
      path: PLAYER_LOG_PATH,
      exists: false,
      hasBridgeEvidence: false,
      error: info.error
    };
  }

  try {
    const text = await fs.readFile(PLAYER_LOG_PATH, "utf8");
    const lines = text.split(/\r?\n/);
    const bridgeLines = lines.filter(line => line.includes("CodexMcpBridge")).slice(-20);
    const modLines = lines.filter(line => /\b(Mod|Mods|Entry\.dll|Entry\.lua|CodexMcpBridge)\b/i.test(line)).slice(-40);
    const result = {
      path: PLAYER_LOG_PATH,
      exists: true,
      sizeBytes: info.sizeBytes,
      modifiedAtUtc: info.modifiedAtUtc,
      hasBridgeEvidence: bridgeLines.length > 0,
      bridgeEvidence: bridgeLines,
      recentModEvidence: modLines
    };
    if (includeTail) {
      result.tail = lines.slice(-tailLines);
    }
    return result;
  } catch (error) {
    return {
      path: PLAYER_LOG_PATH,
      exists: true,
      hasBridgeEvidence: false,
      error: String(error?.message || error)
    };
  }
}

async function inspectGameProcess() {
  const command = "$names=@(\"Witch's Apocalyptic Journey\",\"Witch's Apocalyptic Journey.exe\");" +
    "Get-Process | Where-Object { $names -contains $_.ProcessName -or $names -contains ($_.ProcessName + '.exe') } |" +
    "Select-Object Id,ProcessName,@{Name='StartTime';Expression={$_.StartTime.ToString('o')}},MainWindowTitle,Path | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], { timeout: 5000 });
    const trimmed = String(stdout || "").trim();
    if (!trimmed) {
      return { ok: true, running: false, processes: [] };
    }
    const parsed = JSON.parse(trimmed);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return {
      ok: true,
      running: processes.length > 0,
      processes
    };
  } catch (error) {
    return {
      ok: false,
      running: false,
      processes: [],
      error: String(error?.message || error)
    };
  }
}

async function localOsCommand(command, params, bridgeError) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      command,
      fallback: "local_os",
      bridgeError: String(bridgeError?.message || bridgeError),
      error: "Local OS fallback is currently implemented for Windows only."
    };
  }

  const payload = Buffer.from(JSON.stringify({ command, params: params || {} }), "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WitchLocalInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
"@
Add-Type -AssemblyName System.Drawing
function Out($obj) { $obj | ConvertTo-Json -Depth 20 -Compress }
function ParamValue($name, $fallback) {
  if ($payload.params -and $payload.params.PSObject.Properties.Name -contains $name -and $null -ne $payload.params.$name) { return $payload.params.$name }
  return $fallback
}
function GameProcess {
  Get-Process | Where-Object { $_.ProcessName -eq "Witch's Apocalyptic Journey" -or $_.ProcessName -eq "Witch's Apocalyptic Journey.exe" } | Select-Object -First 1
}
function GameWindow {
  $p = GameProcess
  if ($p -and $p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }
  return [IntPtr]::Zero
}
function FocusGame {
  $hwnd = GameWindow
  $before = [WitchLocalInput]::GetForegroundWindow()
  $restored = $false
  $focused = $false
  if ($hwnd -ne [IntPtr]::Zero) {
    $restored = [WitchLocalInput]::ShowWindow($hwnd, 9)
    $focused = [WitchLocalInput]::SetForegroundWindow($hwnd)
  }
  Start-Sleep -Milliseconds 50
  $after = [WitchLocalInput]::GetForegroundWindow()
  return @{ ok = ($hwnd -ne [IntPtr]::Zero); data = @{ requestedWindow = $hwnd.ToInt64(); foregroundBefore = $before.ToInt64(); foregroundAfter = $after.ToInt64(); restored = $restored; focused = $focused; isForeground = ($hwnd -ne [IntPtr]::Zero -and $after -eq $hwnd) } }
}
function KeyCode($key) {
  if ([string]::IsNullOrWhiteSpace($key)) { return 0 }
  $k = "$key".Trim()
  if ($k.Length -eq 1) {
    $ch = [char]::ToUpperInvariant($k[0])
    if ($ch -ge [char]'A' -and $ch -le [char]'Z') { return [int][char]$ch }
    if ($ch -ge [char]'0' -and $ch -le [char]'9') { return [int][char]$ch }
  }
  switch (($k -replace '[_\\-\\s]', '').ToLowerInvariant()) {
    'backspace' { 0x08; break }
    'tab' { 0x09; break }
    'enter' { 0x0D; break }
    'return' { 0x0D; break }
    'shift' { 0x10; break }
    'ctrl' { 0x11; break }
    'control' { 0x11; break }
    'alt' { 0x12; break }
    'escape' { 0x1B; break }
    'esc' { 0x1B; break }
    'space' { 0x20; break }
    'pageup' { 0x21; break }
    'pagedown' { 0x22; break }
    'end' { 0x23; break }
    'home' { 0x24; break }
    'left' { 0x25; break }
    'up' { 0x26; break }
    'right' { 0x27; break }
    'down' { 0x28; break }
    'insert' { 0x2D; break }
    'delete' { 0x2E; break }
    'del' { 0x2E; break }
    default {
      $normalized = ($k -replace '[_\\-\\s]', '').ToLowerInvariant()
      if ($normalized.StartsWith('f')) {
        $n = 0
        if ([int]::TryParse($normalized.Substring(1), [ref]$n) -and $n -ge 1 -and $n -le 24) { return 0x70 + $n - 1 }
      }
      return 0
    }
  }
}
function KeyDown($vk) { if ($vk -ne 0) { [WitchLocalInput]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) } }
function KeyUp($vk) { if ($vk -ne 0) { [WitchLocalInput]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) } }
function ClientPoint($x, $y, $origin) {
  $pt = New-Object WitchLocalInput+POINT
  $pt.X = [int][Math]::Round([double]$x)
  $pt.Y = [int][Math]::Round([double]$y)
  if ($origin -ne 'desktop') {
    $hwnd = GameWindow
    if ($origin -ne 'topLeft') {
      $rect = New-Object WitchLocalInput+RECT
      if ([WitchLocalInput]::GetWindowRect($hwnd, [ref]$rect)) {
        $pt.Y = ($rect.Bottom - $rect.Top) - $pt.Y
      }
    }
    if ($hwnd -ne [IntPtr]::Zero) { [void][WitchLocalInput]::ClientToScreen($hwnd, [ref]$pt) }
  }
  return $pt
}
if ($payload.params.focus -ne $false -and ($payload.command -eq 'input.key' -or $payload.command -eq 'input.text' -or $payload.command -eq 'input.mouse')) { [void](FocusGame) }
switch ($payload.command) {
  'screen.info' {
    $p = GameProcess
    $hwnd = GameWindow
    $rect = New-Object WitchLocalInput+RECT
    $hasRect = $hwnd -ne [IntPtr]::Zero -and [WitchLocalInput]::GetWindowRect($hwnd, [ref]$rect)
    $data = @{ process = $null; activeWindow = $hwnd.ToInt64(); windowRect = $null }
    if ($p) { $data.process = @{ id = $p.Id; processName = $p.ProcessName; mainWindowTitle = $p.MainWindowTitle; path = $p.Path } }
    if ($hasRect) { $data.windowRect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } }
    Out @{ ok = ($p -ne $null); data = $data }
  }
  'screen.capture' {
    $directory = ParamValue 'directory' $null
    $requestedPath = ParamValue 'path' $null
    if ([string]::IsNullOrWhiteSpace($directory)) { $directory = Join-Path $env:TEMP 'CodexMcpBridge\\captures' }
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    if ([string]::IsNullOrWhiteSpace($requestedPath)) { $requestedPath = Join-Path $directory ('witch_local_' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss_fff') + '.png') }
    if (-not [IO.Path]::IsPathRooted($requestedPath)) { $requestedPath = Join-Path $directory $requestedPath }
    $hwnd = GameWindow
    $rect = New-Object WitchLocalInput+RECT
    $hasRect = $hwnd -ne [IntPtr]::Zero -and [WitchLocalInput]::GetWindowRect($hwnd, [ref]$rect)
    if (-not $hasRect) { Out @{ ok = $false; error = 'Game window was not found for local screenshot.' }; exit 0 }
    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
    $bmp = New-Object Drawing.Bitmap $width, $height
    $graphics = [Drawing.Graphics]::FromImage($bmp)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object Drawing.Size $width, $height))
      $bmp.Save($requestedPath, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $bmp.Dispose()
    }
    Out @{ ok = $true; data = @{ fullPath = [IO.Path]::GetFullPath($requestedPath); isAsync = $false; width = $width; height = $height } }
  }
  'window.focus' { Out (FocusGame) }
  'input.key' {
    $vk = KeyCode $payload.params.key
    if ($vk -eq 0) { Out @{ ok = $false; error = "Unsupported key: $($payload.params.key)" }; exit 0 }
    $mods = @($payload.params.modifiers)
    foreach ($m in $mods) { KeyDown (KeyCode $m) }
    $repeat = [Math]::Max(1, [int](ParamValue 'repeat' 1))
    $action = "$(ParamValue 'action' 'press')"
    for ($i = 0; $i -lt $repeat; $i++) {
      if ($action -eq 'down') { KeyDown $vk } elseif ($action -eq 'up') { KeyUp $vk } else { KeyDown $vk; KeyUp $vk }
    }
    [array]::Reverse($mods)
    foreach ($m in $mods) { KeyUp (KeyCode $m) }
    Out @{ ok = $true; data = @{ key = $payload.params.key; action = $action; repeat = $repeat } }
  }
  'input.text' {
    $text = "$($payload.params.text)"
    foreach ($c in $text.ToCharArray()) {
      $down = New-Object WitchLocalInput+INPUT
      $down.type = 1
      $down.U.ki.wScan = [ushort][char]$c
      $down.U.ki.dwFlags = 4
      $up = $down
      $up.U.ki.dwFlags = 6
      [WitchLocalInput+INPUT[]]$inputs = @($down, $up)
      [void][WitchLocalInput]::SendInput([uint32]$inputs.Length, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][WitchLocalInput+INPUT]))
    }
    Out @{ ok = $true; data = @{ length = $text.Length } }
  }
  'input.mouse' {
    $origin = "$(ParamValue 'origin' 'unity')"
    $action = "$(ParamValue 'action' 'click')"
    $button = "$(ParamValue 'button' 'left')"
    $pt = New-Object WitchLocalInput+POINT
    if ($null -ne $payload.params.x -and $null -ne $payload.params.y) {
      $pt = ClientPoint $payload.params.x $payload.params.y $origin
      [void][WitchLocalInput]::SetCursorPos($pt.X, $pt.Y)
    } else {
      [void][WitchLocalInput]::GetCursorPos([ref]$pt)
    }
    $down = 0x0002; $up = 0x0004
    if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 } elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
    if ($action -eq 'move') {
    } elseif ($action -eq 'down') {
      [WitchLocalInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($action -eq 'up') {
      [WitchLocalInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($action -eq 'scroll') {
      $delta = [int](ParamValue 'delta' (ParamValue 'scrollY' 0))
      [WitchLocalInput]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero)
    } else {
      [WitchLocalInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [WitchLocalInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($action -eq 'double_click') {
        [WitchLocalInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        [WitchLocalInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      }
    }
    Out @{ ok = $true; data = @{ action = $action; button = $button; position = @{ x = $pt.X; y = $pt.Y } } }
  }
  default { Out @{ ok = $false; error = "Unsupported local fallback command: $($payload.command)" } }
}
`;

  try {
    const { stdout, stderr } = await execFileAsync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 10000 });
    const text = String(stdout || "").trim();
    const parsed = text ? JSON.parse(text) : { ok: false, error: "Local OS fallback returned no output." };
    return {
      ...parsed,
      command,
      fallback: "local_os",
      bridgeError: String(bridgeError?.message || bridgeError),
      stderr: String(stderr || "").trim() || undefined
    };
  } catch (error) {
    return {
      ok: false,
      command,
      fallback: "local_os",
      bridgeError: String(bridgeError?.message || bridgeError),
      error: String(error?.message || error),
      stderr: String(error?.stderr || "").trim() || undefined,
      stdout: String(error?.stdout || "").trim() || undefined
    };
  }
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options || {}, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseTimestampMs(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function publicTimedEntry(entry) {
  if (!entry) return null;
  const result = { ...entry };
  delete result.modifiedMs;
  delete result.startMs;
  return result;
}

function compareBridgeArtifactFreshness(modFiles, processInfo) {
  const artifacts = [];
  const processEntries = [];

  for (const root of Array.isArray(modFiles) ? modFiles : []) {
    for (const [name, info] of [
      ["root", root],
      ["modConfig", root.modConfig],
      ["icon", root.icon],
      ["entryDll", root.dll],
      ["entryLuaDisabled", root.scriptEntries?.disabledLua],
      ["devSource", root.devSource]
    ]) {
      const modifiedMs = parseTimestampMs(info?.modifiedAtUtc);
      if (info?.exists === true && modifiedMs !== null) {
        artifacts.push({
          name,
          root: root.root,
          path: info.path,
          type: info.type,
          modifiedAtUtc: info.modifiedAtUtc,
          modifiedMs
        });
      }
    }
  }

  for (const processItem of Array.isArray(processInfo?.processes) ? processInfo.processes : []) {
    const startTime = processItem.StartTime ?? processItem.startTime;
    const startMs = parseTimestampMs(startTime);
    if (startMs !== null) {
      processEntries.push({
        id: processItem.Id ?? processItem.id,
        processName: processItem.ProcessName ?? processItem.processName,
        startTime,
        mainWindowTitle: processItem.MainWindowTitle ?? processItem.mainWindowTitle,
        path: processItem.Path ?? processItem.path,
        startMs
      });
    }
  }

  const newestBridgeArtifact = artifacts.reduce((best, item) => !best || item.modifiedMs > best.modifiedMs ? item : best, null);
  const oldestGameProcess = processEntries.reduce((best, item) => !best || item.startMs < best.startMs ? item : best, null);
  const processStartedBeforeNewestArtifact = !!(newestBridgeArtifact && oldestGameProcess && oldestGameProcess.startMs < newestBridgeArtifact.modifiedMs);

  return {
    ok: true,
    artifactCount: artifacts.length,
    processCount: processEntries.length,
    processStartedBeforeNewestArtifact,
    newestBridgeArtifact: publicTimedEntry(newestBridgeArtifact),
    oldestGameProcess: publicTimedEntry(oldestGameProcess),
    processToNewestArtifactDeltaMs: newestBridgeArtifact && oldestGameProcess ? oldestGameProcess.startMs - newestBridgeArtifact.modifiedMs : null
  };
}

function classifyRuntimeState(state) {
  const modReady = state.modFiles.some(root => root.exists && root.modConfig?.exists && root.dll?.exists);
  const manifestReady = state.modFiles.some(root => root.exists && root.modConfig?.exists && root.manifestChecks?.ok === true);
  const allMarkersReady = state.modFiles.some(root => {
    if (!root.dll?.exists) return false;
    return BRIDGE_MARKERS.every(marker => root.dllMarkers?.[marker] === true);
  });

  if (state.bridgeStatus?.ok) {
    return {
      nextStep: "bridge_ready",
      reason: "The in-game bridge responded through the MCP server.",
      recommendation: "Run witch_verify_readiness, then use witch_takeover_step or witch_takeover_drive with dryRun first."
    };
  }

  if (!modReady) {
    return {
      nextStep: "install_or_rebuild_mod",
      reason: "CodexMcpBridge ModConfig.json or Scripts/Entry.dll is missing from both expected mod roots.",
      recommendation: "Run tools/compile-bridge.ps1, then restart the game."
    };
  }

  if (!manifestReady) {
    return {
      nextStep: "fix_mod_manifest",
      reason: "CodexMcpBridge ModConfig.json exists, but one or more manifest/icon checks failed.",
      recommendation: "Compare modFiles[].manifestChecks with a known loaded mod, fix ModConfig.json/IconPath, and re-run witch_runtime_diagnostics."
    };
  }

  if (!allMarkersReady) {
    return {
      nextStep: "rebuild_mod",
      reason: "Entry.dll exists, but one or more expected bridge command/version markers were not found.",
      recommendation: "Run tools/compile-bridge.ps1 and re-run witch_runtime_diagnostics."
    };
  }

  if (state.processInfo?.running) {
    if (!state.logEvidence?.hasBridgeEvidence) {
      const processPredatesBridge = state.bridgeArtifactFreshness?.processStartedBeforeNewestArtifact === true;
      return {
        nextStep: "restart_game_to_load_mod",
        reason: processPredatesBridge
          ? "The game is running, the bridge is offline, Player.log has no CodexMcpBridge evidence, and the current game process started before the newest bridge artifact was written."
          : "The game is running, the bridge is offline, and Player.log has no CodexMcpBridge evidence.",
        recommendation: processPredatesBridge
          ? "Restart the game so the updated CodexMcpBridge ModConfig.json and Entry.dll are discovered by a fresh process."
          : "Restart the game so the installed ModConfig.json and Entry.dll are discovered."
      };
    }
    return {
      nextStep: "inspect_player_log",
      reason: "The game is running and the bridge is offline even though Player.log mentions CodexMcpBridge.",
      recommendation: "Inspect playerLog.bridgeEvidence and recentModEvidence for loader or bridge startup errors."
    };
  }

  return {
    nextStep: "start_game",
    reason: "The bridge mod appears installed, but no running game process was found.",
    recommendation: "Start the game, then run witch_wait_bridge or witch_runtime_diagnostics again."
  };
}

async function collectGameSnapshot(args) {
  const snapshot = {
    ok: true,
    capturedAtUtc: new Date().toISOString(),
    status: await safeCallBridge("status", {})
  };

  if (!snapshot.status.ok) {
    snapshot.ok = false;
    return snapshot;
  }

  const tasks = [];
  if (args?.includeUi !== false) {
    tasks.push(["ui", safeCallBridge("ui.snapshot", { includeHidden: !!args?.includeHidden })]);
  }
  if (args?.includeScene !== false) {
    tasks.push(["scene", safeCallBridge("scene.snapshot", { includeInactive: false, onlyInteractive: args?.onlyInteractive !== false })]);
  }
  if (args?.includeLegalActions !== false) {
    tasks.push(["legalActions", safeCallBridge("game.legal_actions", {})]);
  }

  const results = await Promise.all(tasks.map(([, promise]) => promise));
  tasks.forEach(([name], index) => {
    snapshot[name] = results[index];
    if (!results[index].ok) snapshot.ok = false;
  });

  return snapshot;
}

async function collectControlMap(args) {
  const snapshot = await collectGameSnapshot({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeUi: args?.includeUi !== false,
    includeScene: args?.includeScene !== false,
    includeLegalActions: args?.includeActions !== false
  });

  if (!snapshot.ok) {
    return {
      ok: false,
      capturedAtUtc: snapshot.capturedAtUtc,
      error: "Unable to build control map because the bridge or one of the required snapshots failed.",
      snapshot
    };
  }

  const operations = [];
  const unmapped = [];

  if (args?.includeActions !== false) {
    const actions = legalActionsFrom(snapshot.legalActions).slice(0, limit(args?.maxActions, 200));
    actions.forEach((action, index) => {
      const summarized = summarizeAction(action);
      const callArgs = summarized.id ? { actionId: summarized.id, contains: false } : { index };
      operations.push({
        id: "legal:" + (summarized.id || index),
        family: "legal_action",
        action: summarized.kind || "perform",
        label: summarized.label || summarized.id || String(index),
        noMouse: true,
        ready: true,
        target: summarized,
        call: { tool: "witch_perform_action_match", arguments: callArgs }
      });
    });
  }

  if (args?.includeUi !== false) {
    const nodes = arrayValue(snapshot.ui?.data || snapshot.ui, "Nodes")
      .filter(item => isUiOperationTarget(item, args || {}))
      .slice(0, limit(args?.maxUiNodes, 200));
    nodes.forEach((item, index) => {
      const node = summarizeUiNode(item);
      const selector = compactUiSelector(node);
      const actions = uiActionsForNode(item);
      if (!hasSelector(selector) || actions.length === 0) {
        if (args?.includeUnsupported !== false) {
          unmapped.push({ family: "ui", reason: !hasSelector(selector) ? "missing_selector" : "missing_supported_actions", target: node });
        }
        return;
      }
      actions.forEach(action => {
        const requirement = extraArgumentsForUiAction(action);
        operations.push({
          id: "ui:" + (node.nodeId || node.instanceId || index) + ":" + action,
          family: "ui",
          action,
          label: node.label || node.text || node.nodeId || node.transformPath || String(index),
          noMouse: true,
          ready: requirement.length === 0,
          requiresArguments: requirement,
          target: node,
          selector,
          call: { tool: "witch_ui_interact", arguments: { action, selector, ...placeholderUiArgs(action) } }
        });
      });
    });
  }

  if (args?.includeScene !== false) {
    const objects = arrayValue(snapshot.scene?.data || snapshot.scene, "Objects")
      .filter(item => isSceneOperationTarget(item, args || {}))
      .slice(0, limit(args?.maxSceneObjects, 200));
    objects.forEach((item, index) => {
      const object = summarizeSceneObject(item);
      const selector = compactSceneSelector(object);
      const actions = sceneActionsForObject(item);
      if (!hasSelector(selector) || actions.length === 0) {
        if (args?.includeUnsupported !== false) {
          unmapped.push({ family: "scene", reason: !hasSelector(selector) ? "missing_selector" : "missing_supported_actions", target: object });
        }
        return;
      }
      actions.forEach(action => {
        const requirement = extraArgumentsForSceneAction(action);
        operations.push({
          id: "scene:" + (object.objectId || object.instanceId || index) + ":" + action,
          family: "scene",
          action,
          label: object.name || object.objectId || object.transformPath || String(index),
          noMouse: true,
          ready: requirement.length === 0,
          requiresArguments: requirement,
          target: object,
          selector,
          call: { tool: "witch_scene_interact", arguments: { action, selector, ...placeholderSceneArgs(action) } }
        });
      });
    });
  }

  const byFamily = {};
  for (const operation of operations) {
    byFamily[operation.family] = (byFamily[operation.family] || 0) + 1;
  }

  return {
    ok: true,
    capturedAtUtc: snapshot.capturedAtUtc,
    noMouseDefault: DEFAULT_NO_MOUSE,
    operationCount: operations.length,
    readyOperationCount: operations.filter(item => item.ready).length,
    unmappedCount: unmapped.length,
    byFamily,
    operations,
    unmapped,
    snapshotSummary: {
      phase: snapshot.legalActions?.data?.Phase || snapshot.legalActions?.data?.phase || null,
      uiNodeCount: arrayValue(snapshot.ui?.data || snapshot.ui, "Nodes").length,
      sceneObjectCount: arrayValue(snapshot.scene?.data || snapshot.scene, "Objects").length
    }
  };
}

async function collectStateSummary(args) {
  const snapshot = await collectGameSnapshot({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeUi: true,
    includeScene: true,
    includeLegalActions: true
  });

  if (!snapshot.ok) {
    return {
      ok: false,
      capturedAtUtc: snapshot.capturedAtUtc,
      status: snapshot.status,
      error: "Unable to collect state summary because the bridge or one of the required snapshots failed."
    };
  }

  const legalActions = legalActionsFrom(snapshot.legalActions);
  const suggestedAction = chooseLegalAction(legalActions, args || {});
  return {
    ok: true,
    capturedAtUtc: snapshot.capturedAtUtc,
    bridge: snapshot.status?.data || snapshot.status,
    ui: summarizeUi(snapshot.ui?.data || snapshot.ui, args || {}),
    scene: summarizeScene(snapshot.scene?.data || snapshot.scene, args || {}),
    legalActions: {
      phase: snapshot.legalActions?.data?.Phase || snapshot.legalActions?.data?.phase || snapshot.legalActions?.Phase || snapshot.legalActions?.phase || null,
      count: legalActions.length,
      actions: legalActions.slice(0, limit(args?.maxActions, 20)).map(summarizeAction)
    },
    suggestedNextAction: suggestedAction ? summarizeAction(suggestedAction) : null
  };
}

function summarizeUi(ui, args) {
  const nodes = arrayValue(ui, "Nodes");
  const windows = arrayValue(ui, "Windows");
  return {
    totalNodes: fieldValue(ui, "TotalNodes") ?? nodes.length,
    layoutSignature: fieldValue(ui, "LayoutSignature"),
    activeWindows: windows
      .filter(item => fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false)
      .slice(0, 20)
      .map(item => ({
        windowName: fieldValue(item, "WindowName"),
        nodeId: fieldValue(item, "NodeId"),
        instanceId: fieldValue(item, "InstanceId"),
        transformPath: fieldValue(item, "TransformPath"),
        siblingIndex: fieldValue(item, "SiblingIndex")
      })),
    clickableNodes: nodes
      .filter(item => fieldValue(item, "Clickable") === true || hasAction(item, "click"))
      .slice(0, limit(args.maxUiNodes, 20))
      .map(item => ({
        nodeId: fieldValue(item, "NodeId"),
        label: fieldValue(item, "Label"),
        text: fieldValue(item, "Text"),
        windowName: fieldValue(item, "WindowName"),
        transformPath: fieldValue(item, "TransformPath"),
        instanceId: fieldValue(item, "InstanceId"),
        visible: fieldValue(item, "Visible"),
        interactable: fieldValue(item, "Interactable"),
        screenRect: fieldValue(item, "ScreenRect"),
        preferredClickPoint: fieldValue(item, "PreferredClickPoint"),
        componentTypes: fieldValue(item, "ComponentTypes") ?? [],
        supportedActions: fieldValue(item, "SupportedActions") ?? []
      }))
  };
}

function summarizeScene(scene, args) {
  const objects = arrayValue(scene, "Objects");
  return {
    sceneName: fieldValue(scene, "SceneName"),
    cameraName: fieldValue(scene, "CameraName"),
    count: objects.length,
    totalObjects: fieldValue(scene, "TotalObjects") ?? objects.length,
    objects: objects
      .filter(item => fieldValue(item, "Interactive") !== false && fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false)
      .slice(0, limit(args.maxSceneObjects, 20))
      .map(item => ({
        objectId: fieldValue(item, "ObjectId"),
        name: fieldValue(item, "Name"),
        instanceId: fieldValue(item, "InstanceId"),
        transformPath: fieldValue(item, "TransformPath"),
        sceneName: fieldValue(item, "SceneName"),
        tag: fieldValue(item, "Tag"),
        layer: fieldValue(item, "Layer"),
        layerName: fieldValue(item, "LayerName"),
        visible: fieldValue(item, "Visible"),
        activeInHierarchy: fieldValue(item, "ActiveInHierarchy"),
        hasCollider3D: fieldValue(item, "HasCollider3D"),
        hasCollider2D: fieldValue(item, "HasCollider2D"),
        hasPointerHandler: fieldValue(item, "HasPointerHandler"),
        screenPoint: fieldValue(item, "ScreenPoint") ?? fieldValue(item, "CenterScreenPoint"),
        screenRect: fieldValue(item, "ScreenRect"),
        componentTypes: fieldValue(item, "ComponentTypes") ?? [],
        supportedActions: fieldValue(item, "SupportedActions") ?? []
      }))
  };
}

function summarizeUiNode(item) {
  return {
    nodeId: fieldValue(item, "NodeId"),
    label: fieldValue(item, "Label"),
    text: fieldValue(item, "Text"),
    windowName: fieldValue(item, "WindowName"),
    transformPath: fieldValue(item, "TransformPath"),
    instanceId: fieldValue(item, "InstanceId"),
    visible: fieldValue(item, "Visible"),
    interactable: fieldValue(item, "Interactable"),
    clickable: fieldValue(item, "Clickable"),
    screenRect: fieldValue(item, "ScreenRect"),
    preferredClickPoint: fieldValue(item, "PreferredClickPoint"),
    componentTypes: fieldValue(item, "ComponentTypes") ?? [],
    supportedActions: fieldValue(item, "SupportedActions") ?? []
  };
}

function summarizeSceneObject(item) {
  return {
    objectId: fieldValue(item, "ObjectId"),
    name: fieldValue(item, "Name"),
    instanceId: fieldValue(item, "InstanceId"),
    transformPath: fieldValue(item, "TransformPath"),
    sceneName: fieldValue(item, "SceneName"),
    tag: fieldValue(item, "Tag"),
    layer: fieldValue(item, "Layer"),
    layerName: fieldValue(item, "LayerName"),
    visible: fieldValue(item, "Visible"),
    activeInHierarchy: fieldValue(item, "ActiveInHierarchy"),
    interactive: fieldValue(item, "Interactive"),
    hasCollider3D: fieldValue(item, "HasCollider3D"),
    hasCollider2D: fieldValue(item, "HasCollider2D"),
    hasPointerHandler: fieldValue(item, "HasPointerHandler"),
    screenPoint: fieldValue(item, "ScreenPoint") ?? fieldValue(item, "CenterScreenPoint"),
    screenRect: fieldValue(item, "ScreenRect"),
    componentTypes: fieldValue(item, "ComponentTypes") ?? [],
    supportedActions: fieldValue(item, "SupportedActions") ?? []
  };
}

function isUiOperationTarget(item, args) {
  if (!args.includeHidden && fieldValue(item, "Visible") === false) return false;
  if (fieldValue(item, "ActiveInHierarchy") === false) return false;
  if (args.onlyInteractive === false) return true;
  return fieldValue(item, "Clickable") === true || normalizedActions(item).length > 0 || isEditableUiNode(item);
}

function isSceneOperationTarget(item, args) {
  if (!args.includeHidden && fieldValue(item, "Visible") === false) return false;
  if (fieldValue(item, "ActiveInHierarchy") === false) return false;
  if (args.onlyInteractive === false) return true;
  return fieldValue(item, "Interactive") !== false && (fieldValue(item, "HasCollider3D") === true || fieldValue(item, "HasCollider2D") === true || fieldValue(item, "HasPointerHandler") === true || normalizedActions(item).length > 0);
}

function uiActionsForNode(item) {
  const actions = normalizedActions(item);
  if (actions.length > 0) return actions;
  if (fieldValue(item, "Clickable") === true) return ["click"];
  if (isEditableUiNode(item)) return ["set_text"];
  return [];
}

function sceneActionsForObject(item) {
  const actions = normalizedActions(item);
  if (actions.length > 0) return actions;
  if (fieldValue(item, "Interactive") !== false) return ["click"];
  return [];
}

function normalizedActions(item) {
  const actions = fieldValue(item, "SupportedActions") ?? [];
  if (!Array.isArray(actions)) return [];
  return [...new Set(actions.map(action => normalizeActionName(action)).filter(Boolean))];
}

function isEditableUiNode(item) {
  if (fieldValue(item, "Interactable") === false) return false;
  const componentTypes = fieldValue(item, "ComponentTypes") ?? [];
  if (!Array.isArray(componentTypes)) return false;
  return componentTypes.some(type => /inputfield|tmp_inputfield|textfield/i.test(String(type || "")));
}

function normalizeActionName(value) {
  return String(value || "").trim().replace(/[-\s]+/g, "_").toLocaleLowerCase();
}

function hasSelector(selector) {
  return !!(selector && Object.values(selector).some(value => value !== undefined && value !== null && value !== ""));
}

function extraArgumentsForUiAction(action) {
  switch (normalizeActionName(action)) {
    case "set_text":
      return ["text"];
    case "drag":
      return ["targetSelector_or_targetPoint_or_delta"];
    case "scroll":
      return ["deltaX_or_deltaY"];
    default:
      return [];
  }
}

function extraArgumentsForSceneAction(action) {
  switch (normalizeActionName(action)) {
    case "drag":
      return ["targetSelector_or_targetPoint"];
    case "scroll":
      return ["scrollX_or_scrollY"];
    default:
      return [];
  }
}

function placeholderUiArgs(action) {
  switch (normalizeActionName(action)) {
    case "set_text":
      return { text: "" };
    case "drag":
      return { targetSelector: undefined, targetPoint: undefined };
    case "scroll":
      return { deltaY: 0 };
    default:
      return {};
  }
}

function placeholderSceneArgs(action) {
  switch (normalizeActionName(action)) {
    case "drag":
      return { targetSelector: undefined, targetPoint: undefined };
    case "scroll":
      return { scrollY: 0 };
    default:
      return {};
  }
}

function summarizeAction(action) {
  return {
    id: actionValue(action, "Id"),
    kind: actionValue(action, "Kind"),
    label: actionValue(action, "Label"),
    description: actionValue(action, "Description"),
    parameters: actionValue(action, "Parameters")
  };
}

async function planNext(args) {
  const summary = await collectStateSummary(args || {});
  if (!summary.ok) {
    return {
      ok: false,
      summary,
      reason: "state_unavailable",
      recommendedCall: null,
      alternatives: [
        { tool: "witch_status", arguments: {}, reason: "Check whether the in-game bridge is online." },
        { tool: "witch_capabilities", arguments: {}, reason: "Inspect local MCP capabilities without the game bridge." }
      ]
    };
  }

  const legal = summary.suggestedNextAction;
  if (legal?.id) {
    return {
      ok: true,
      strategy: "legal_action",
      reason: "Use the game's own legal-action layer before low-level UI or scene interaction.",
      summary,
      recommendedCall: {
        tool: "witch_perform_action_match",
        arguments: { ...compactActionPolicyArgs(args || {}), actionId: legal.id, contains: false }
      },
      dryRunCall: {
        tool: "witch_auto_step",
        arguments: {
          ...compactActionPolicyArgs(args || {}),
          dryRun: true,
          actionId: legal.id,
          includeLegalActions: true
        }
      },
      alternatives: [
        {
          tool: "witch_perform_action_match",
          arguments: { actionId: legal.id, contains: false },
          reason: "Re-select the action from the current legal-action list by id before executing."
        },
        {
          tool: "witch_state_summary",
          arguments: compactPolicyArgs(args || {}),
          reason: "Refresh compact state before committing to the action."
        }
      ]
    };
  }

  if (args?.allowUiFallback !== false) {
    const node = summary.ui?.clickableNodes?.[0];
    if (node?.label || node?.nodeId || node?.instanceId) {
      return {
        ok: true,
        strategy: "ui_click",
        reason: "No legal action was suggested; use the first visible clickable UI node.",
        summary,
        recommendedCall: node.label
          ? { tool: "witch_ui_click_label", arguments: { label: node.label, windowName: node.windowName } }
          : { tool: "witch_ui_interact", arguments: { action: "click", selector: compactUiSelector(node) } },
        alternatives: [
          { tool: "witch_ui_snapshot", arguments: { includeHidden: false }, reason: "Refresh UI tree before clicking." }
        ]
      };
    }
  }

  if (args?.allowSceneFallback !== false) {
    const object = summary.scene?.objects?.[0];
    if (object?.objectId || object?.instanceId || object?.name) {
      return {
        ok: true,
        strategy: "scene_interact",
        reason: "No legal action or UI click was suggested; use the first visible interactive scene object.",
        summary,
        recommendedCall: {
          tool: "witch_scene_interact",
          arguments: { action: "click", selector: compactSceneSelector(object) }
        },
        alternatives: [
          { tool: "witch_scene_snapshot", arguments: { onlyInteractive: true }, reason: "Refresh scene objects before interacting." }
        ]
      };
    }
  }

  return {
    ok: false,
    strategy: "observe",
    reason: "No legal action, clickable UI node, or scene object was available.",
    summary,
    recommendedCall: { tool: "witch_state_summary", arguments: compactPolicyArgs(args || {}) },
    alternatives: [
      { tool: "witch_game_snapshot", arguments: { includeHidden: false, onlyInteractive: true }, reason: "Collect the broader raw snapshot for manual inspection." }
    ]
  };
}

function compactPolicyArgs(args) {
  return pruneUndefined({
    includeHidden: !!args.includeHidden,
    onlyInteractive: args.onlyInteractive !== false,
    preferKinds: args.preferKinds,
    preferLabels: args.preferLabels,
    avoidKinds: args.avoidKinds,
    avoidLabels: args.avoidLabels,
    ...compactActionPolicyArgs(args)
  });
}

function compactActionPolicyArgs(args) {
  return pruneUndefined({
    allowActionIds: args.allowActionIds,
    allowKinds: args.allowKinds,
    allowLabels: args.allowLabels,
    denyActionIds: args.denyActionIds,
    denyKinds: args.denyKinds,
    denyLabels: args.denyLabels
  });
}

function compactUiSelector(node) {
  const selector = {};
  if (node.nodeId) selector.nodeId = node.nodeId;
  if (Number.isInteger(node.instanceId)) selector.instanceId = node.instanceId;
  if (node.windowName) selector.windowName = node.windowName;
  if (node.transformPath) selector.transformPath = node.transformPath;
  if (node.label) selector.label = node.label;
  return selector;
}

function compactSceneSelector(object) {
  const selector = {};
  if (object.objectId) selector.objectId = object.objectId;
  if (Number.isInteger(object.instanceId)) selector.instanceId = object.instanceId;
  if (object.transformPath) selector.transformPath = object.transformPath;
  if (object.name) selector.name = object.name;
  return selector;
}

function pruneUndefined(obj) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

async function executePlan(args) {
  const dryRun = args?.dryRun !== false;
  const plan = await planNext(args || {});
  if (!plan.ok || !plan.recommendedCall) {
    return { ok: false, dryRun, plan, result: null };
  }

  if (dryRun) {
    const previewCall = plan.dryRunCall || {
      tool: plan.recommendedCall.tool,
      arguments: { ...plan.recommendedCall.arguments, dryRun: true }
    };
    const preview = await executeRecommendedCall(previewCall, { forceDryRun: true });
    return {
      ok: preview?.ok !== false,
      dryRun: true,
      plan,
      previewCall,
      result: preview
    };
  }

  const result = await executeRecommendedCall(plan.recommendedCall, { forceDryRun: false });
  const response = {
    ok: result?.ok !== false,
    dryRun: false,
    plan,
    executedCall: plan.recommendedCall,
    result
  };
  if (args?.includePostSummary !== false) {
    response.postSummary = await collectStateSummary(args || {});
  }
  return response;
}

async function takeoverStep(args) {
  const dryRun = args?.dryRun !== false;
  const policy = compactPolicyArgs(args || {});
  const result = {
    ok: true,
    dryRun,
    capturedAtUtc: new Date().toISOString(),
    steps: {}
  };

  if (args?.waitBridge !== false) {
    result.steps.bridge = await waitForBridge({
      timeoutMs: args?.bridgeTimeoutMs ?? 30000,
      pollMs: args?.bridgePollMs ?? 500
    });
    if (!result.steps.bridge?.ok) {
      result.ok = false;
      result.reason = "bridge_unavailable";
      return result;
    }
  }

  if (args?.focusWindow !== false) {
    result.steps.focus = dryRun
      ? { ok: true, skipped: true, plannedTool: "witch_window_focus", arguments: {} }
      : await callBridge("window.focus", {});
    if (result.steps.focus?.ok === false) {
      result.ok = false;
      result.reason = "focus_failed";
      return result;
    }
  }

  if (args?.includeScreenshot !== false) {
    const screenshotArgs = {
      path: args?.screenshotPath,
      directory: args?.screenshotDirectory,
      timeoutMs: args?.screenshotTimeoutMs ?? 5000,
      pollMs: args?.screenshotPollMs ?? 100
    };
    result.steps.screenshot = dryRun
      ? { ok: true, skipped: true, plannedTool: "witch_screen_capture_wait", arguments: screenshotArgs }
      : await captureAndWait(screenshotArgs);
    if (result.steps.screenshot?.ok === false) {
      result.ok = false;
      result.reason = "screenshot_failed";
      return result;
    }
  }

  result.steps.summary = await collectStateSummary(policy);
  if (!result.steps.summary?.ok) {
    result.ok = false;
    result.reason = "state_unavailable";
    return result;
  }

  result.steps.plan = await planNext(args || {});
  if (!result.steps.plan?.ok || !result.steps.plan?.recommendedCall) {
    result.ok = false;
    result.reason = "no_executable_plan";
    return result;
  }

  if (dryRun) {
    const previewCall = result.steps.plan.dryRunCall || {
      tool: result.steps.plan.recommendedCall.tool,
      arguments: { ...result.steps.plan.recommendedCall.arguments, dryRun: true }
    };
    result.steps.previewCall = previewCall;
    result.steps.execution = await executeRecommendedCall(previewCall, { forceDryRun: true });
  } else {
    result.steps.executedCall = result.steps.plan.recommendedCall;
    result.steps.execution = await executeRecommendedCall(result.steps.plan.recommendedCall, { forceDryRun: false });
  }

  if (result.steps.execution?.ok === false) {
    result.ok = false;
    result.reason = dryRun ? "preview_failed" : "execution_failed";
    return result;
  }

  if (args?.includePostSummary !== false) {
    result.steps.postSummary = dryRun
      ? { ok: true, skipped: true, reason: "dry_run" }
      : await collectStateSummary(policy);
  }

  return result;
}

async function takeoverDrive(args) {
  const maxSteps = Math.max(1, Math.min(25, Number(args?.maxSteps ?? 3)));
  const waitAfterMs = Math.max(0, Math.min(10000, Number(args?.waitAfterMs ?? 250)));
  const dryRun = args?.dryRun !== false;
  const steps = [];

  for (let index = 0; index < maxSteps; index++) {
    const stepArgs = {
      ...args,
      dryRun,
      includePostSummary: args?.includePostSummary !== false,
      waitBridge: index === 0 ? args?.waitBridge !== false : false
    };
    const step = await takeoverStep(stepArgs);
    steps.push({ index, ...step });

    if (!step.ok) {
      return {
        ok: args?.stopOnFailure !== false ? false : steps.every(item => item.ok !== false),
        dryRun,
        stopped: true,
        reason: step.reason || "step_failed",
        steps
      };
    }

    const recommended = step.steps?.plan?.summary?.suggestedNextAction || step.steps?.summary?.suggestedNextAction;
    const stopReason = recommended ? stopReasonForAction(recommended, args || {}) : null;
    if (stopReason) {
      return { ok: true, dryRun, stopped: true, reason: stopReason, steps };
    }

    if (dryRun) {
      return { ok: true, dryRun, stopped: true, reason: "dry_run", steps };
    }

    if (waitAfterMs > 0 && index < maxSteps - 1) {
      await new Promise(resolve => setTimeout(resolve, waitAfterMs));
    }
  }

  return { ok: true, dryRun, stopped: true, reason: "max_steps", steps };
}

async function executeRecommendedCall(call, options) {
  if (!call?.tool) {
    return { ok: false, error: "Missing recommended tool call." };
  }
  const args = call.arguments || {};
  switch (call.tool) {
    case "witch_perform_action":
      if (options?.forceDryRun) {
        return autoStep({ dryRun: true, actionId: args.actionId, includeLegalActions: true });
      }
      return callBridge("game.perform_action", { actionId: args.actionId });
    case "witch_perform_action_match":
      if (options?.forceDryRun) {
        return autoStep({ dryRun: true, ...args, includeLegalActions: true });
      }
      return performMatchingAction(args);
    case "witch_auto_step":
      return autoStep({ ...args, dryRun: options?.forceDryRun ? true : !!args.dryRun });
    case "witch_ui_click_label":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridge("ui.interact", {
        action: "click",
        selector: { label: args.label, windowName: args.windowName },
        requireClickable: args.requireClickable !== false,
        includePostSnapshot: args.includePostSnapshot !== false
      });
    case "witch_ui_interact":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridge("ui.interact", args);
    case "witch_scene_interact":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridge("scene.interact", args);
    case "witch_input_key":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridgeWithLocalFallback("input.key", args);
    case "witch_input_text":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridgeWithLocalFallback("input.text", args);
    case "witch_input_mouse":
      if (noMouseEnabled(args)) {
        return rejectMouseCommand("input.mouse", args);
      }
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridgeWithLocalFallback("input.mouse", args);
    case "witch_screen_capture":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridgeWithLocalFallback("screen.capture", args);
    case "witch_screen_capture_wait":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return captureAndWait(args);
    case "witch_window_focus":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridgeWithLocalFallback("window.focus", args);
    case "witch_runtime_invoke_static":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return callBridge("runtime.invoke_static", args);
    case "witch_runtime_component_call": {
      const componentArgs = { ...args, dryRun: options?.forceDryRun ? true : args.dryRun !== false };
      if (componentArgs.dryRun) {
        delete componentArgs.confirm;
      }
      return callBridge("runtime.component_call", componentArgs);
    }
    case "witch_runtime_component_set": {
      const componentArgs = { ...args, dryRun: options?.forceDryRun ? true : args.dryRun !== false };
      if (componentArgs.dryRun) {
        delete componentArgs.confirm;
      }
      return callBridge("runtime.component_set", componentArgs);
    }
    case "witch_state_summary":
      return collectStateSummary(args);
    case "witch_game_snapshot":
      return collectGameSnapshot(args);
    default:
      return { ok: false, error: "Refusing to execute unsupported planned tool: " + call.tool, call };
  }
}

async function runBatch(args) {
  const inputSteps = Array.isArray(args?.steps) ? args.steps : [];
  const maxSteps = Math.max(0, Math.min(50, Number(args?.maxSteps ?? 10)));
  const dryRun = args?.dryRun !== false;
  const stopOnError = args?.stopOnError !== false;
  const results = [];

  for (let index = 0; index < Math.min(inputSteps.length, maxSteps); index++) {
    const step = inputSteps[index] || {};
    const result = await executeBatchStep(step, { dryRun });
    results.push({ index, tool: step.tool, arguments: step.arguments || {}, result });
    if (stopOnError && result?.ok === false) {
      return { ok: false, dryRun, stopped: true, reason: "step_failed", results };
    }
  }

  return {
    ok: results.every(item => item.result?.ok !== false),
    dryRun,
    stopped: inputSteps.length > maxSteps,
    reason: inputSteps.length > maxSteps ? "max_steps" : "completed",
    results
  };
}

async function executeBatchStep(step, options) {
  const tool = step?.tool;
  const args = step?.arguments || {};
  switch (tool) {
    case "witch_capabilities":
      return localCapabilities();
    case "witch_runtime_diagnostics":
      return runtimeDiagnostics(args);
    case "witch_watch_bridge_load":
      return watchBridgeLoad(args);
    case "witch_restart_and_watch_bridge":
      return restartAndWatchBridge(args);
    case "witch_prepare_takeover":
      return prepareTakeover({ ...args, restartIfRunning: false });
    case "witch_wait_bridge":
      return waitForBridge(args);
    case "witch_verify_readiness":
      return verifyReadiness(args);
    case "witch_takeover_audit":
      return takeoverAudit(args);
    case "witch_no_mouse_audit":
      return noMouseAudit(args);
    case "witch_no_mouse_coverage":
      return noMouseCoverage(args);
    case "witch_status":
      return safeCallBridge("status", {});
    case "witch_game_snapshot":
      return collectGameSnapshot(args);
    case "witch_control_map":
      return collectControlMap(args);
    case "witch_state_summary":
      return collectStateSummary(args);
    case "witch_plan_next":
      return planNext(args);
    case "witch_execute_plan":
      return executePlan({ ...args, dryRun: options?.dryRun ? true : args.dryRun === true });
    case "witch_takeover_step":
      return takeoverStep({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_takeover_drive":
      return takeoverDrive({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_find_targets":
      return findTargets(args);
    case "witch_legal_actions":
      return safeCallBridge("game.legal_actions", {});
    case "witch_ui_snapshot":
      return safeCallBridge("ui.snapshot", { scope: args.scope || "", includeHidden: !!args.includeHidden });
    case "witch_scene_snapshot":
      return safeCallBridge("scene.snapshot", { includeInactive: !!args.includeInactive, onlyInteractive: args.onlyInteractive !== false });
    case "witch_screen_info":
      return safeCallBridge("screen.info", {});
    case "witch_runtime_inspect":
      return safeCallBridge("runtime.inspect", args);
    case "witch_runtime_objects":
      return safeCallBridge("runtime.objects", args);
    case "witch_runtime_object_detail":
      return safeCallBridge("runtime.object_detail", args);
    case "witch_runtime_component_members":
      return safeCallBridge("runtime.component_members", args);
    case "witch_runtime_component_call":
    case "witch_runtime_component_set":
    case "witch_runtime_invoke_static":
      return executeRecommendedCall({ tool, arguments: args }, { forceDryRun: options?.dryRun });
    case "witch_window_focus":
      return executeRecommendedCall({ tool, arguments: args }, { forceDryRun: options?.dryRun });
    case "witch_perform_action":
    case "witch_perform_action_match":
    case "witch_auto_step":
    case "witch_ui_click_label":
    case "witch_ui_interact":
    case "witch_scene_interact":
    case "witch_input_key":
    case "witch_input_text":
    case "witch_input_mouse":
    case "witch_screen_capture":
    case "witch_screen_capture_wait":
    case "witch_window_focus":
      return executeRecommendedCall({ tool, arguments: args }, { forceDryRun: options?.dryRun });
    default:
      return { ok: false, error: "Tool is not approved for witch_batch: " + tool };
  }
}

async function findTargets(args) {
  const query = String(args?.query || "").trim();
  const summary = await collectStateSummary({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    maxUiNodes: 200,
    maxSceneObjects: 200,
    maxActions: 200
  });
  if (!summary.ok) {
    return { ok: false, query, summary, results: [] };
  }

  const results = [];
  if (args?.includeActions !== false) {
    for (const action of summary.legalActions?.actions || []) {
      const score = targetScore(query, [action.id, action.kind, action.label, action.description]);
      if (score > 0) {
        results.push({
          type: "legal_action",
          score,
          action,
          nextCall: { tool: "witch_perform_action", arguments: { actionId: action.id } }
        });
      }
    }
  }

  if (args?.includeUi !== false) {
    for (const node of summary.ui?.clickableNodes || []) {
      const score = targetScore(query, [node.nodeId, node.label, node.text, node.windowName, node.transformPath, ...(node.componentTypes || [])]);
      if (score > 0) {
        const selector = compactUiSelector(node);
        results.push({
          type: "ui_node",
          score,
          node,
          selector,
          nextCall: { tool: "witch_ui_interact", arguments: { action: "click", selector } }
        });
      }
    }
  }

  if (args?.includeScene !== false) {
    for (const object of summary.scene?.objects || []) {
      const score = targetScore(query, [object.objectId, object.name, object.sceneName, object.tag, object.layerName, object.transformPath, ...(object.componentTypes || [])]);
      if (score > 0) {
        const selector = compactSceneSelector(object);
        results.push({
          type: "scene_object",
          score,
          object,
          selector,
          nextCall: { tool: "witch_scene_interact", arguments: { action: "click", selector } }
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score || typeRank(a.type) - typeRank(b.type));
  return {
    ok: true,
    query,
    count: results.length,
    results: results.slice(0, limit(args?.maxResults, 20)),
    summary: {
      capturedAtUtc: summary.capturedAtUtc,
      phase: summary.legalActions?.phase,
      activeWindows: summary.ui?.activeWindows,
      sceneName: summary.scene?.sceneName
    }
  };
}

function targetScore(query, values) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 1;
  let score = 0;
  for (const value of values) {
    if (value == null) continue;
    const normalized = normalizeText(String(value));
    if (!normalized) continue;
    if (normalized === normalizedQuery) score = Math.max(score, 100);
    else if (normalized.includes(normalizedQuery)) score = Math.max(score, 50);
    else if (normalizedQuery.includes(normalized)) score = Math.max(score, 20);
  }
  return score;
}

function typeRank(type) {
  if (type === "legal_action") return 0;
  if (type === "ui_node") return 1;
  if (type === "scene_object") return 2;
  return 3;
}

function normalizeText(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function safeCallBridge(command, params) {
  try {
    return await callBridgeWithLocalFallback(command, params);
  } catch (error) {
    return { ok: false, command, error: String(error?.message || error) };
  }
}

async function performMatchingAction(args) {
  const legal = await callBridge("game.legal_actions", {});
  const actions = legal?.data?.Actions || legal?.data?.actions || [];
  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, error: "No legal actions are available.", legalActions: legal };
  }

  const selected = selectLegalAction(actions, args || {});
  if (!selected) {
    return { ok: false, error: "No legal action matched the requested selector.", selector: args || {}, legalActions: legal };
  }

  const policy = evaluateActionPolicy(selected, args || {});
  if (!policy.ok) {
    return { ok: false, stopped: true, reason: "action_policy_denied", selected, policy, legalActions: legal };
  }

  const actionId = selected.Id || selected.id;
  if (!actionId) {
    return { ok: false, error: "Matched action has no action id.", selected, legalActions: legal };
  }

  const result = await callBridge("game.perform_action", { actionId });
  return { ok: result?.ok !== false, selected, result };
}

async function autoStep(args) {
  const legal = await callBridge("game.legal_actions", {});
  const actions = legalActionsFrom(legal);
  if (actions.length === 0) {
    return { ok: false, stopped: true, reason: "no_legal_actions", legalActions: legal };
  }

  const selected = selectLegalAction(actions, args || {}) || chooseLegalAction(actions, args || {});
  if (!selected) {
    return { ok: false, stopped: true, reason: "no_matching_action", selector: args || {}, legalActions: legal };
  }

  const policy = evaluateActionPolicy(selected, args || {});
  if (!policy.ok) {
    return { ok: false, stopped: true, reason: "action_policy_denied", selected, policy, legalActions: legal };
  }

  const actionId = actionValue(selected, "Id");
  if (!actionId) {
    return { ok: false, stopped: true, reason: "selected_action_has_no_id", selected, legalActions: legal };
  }

  const response = {
    ok: true,
    dryRun: !!args?.dryRun,
    selected,
    policy
  };
  if (args?.includeLegalActions !== false) {
    response.legalActions = legal;
  }
  if (args?.dryRun) {
    response.result = { ok: true, skipped: true, actionId };
    return response;
  }

  response.result = await callBridge("game.perform_action", { actionId });
  response.ok = response.result?.ok !== false;
  return response;
}

async function autoDrive(args) {
  const maxSteps = Math.max(1, Math.min(100, Number(args?.maxSteps ?? 5)));
  const waitAfterMs = Math.max(0, Math.min(10000, Number(args?.waitAfterMs ?? 250)));
  const steps = [];

  for (let i = 0; i < maxSteps; i++) {
    const legal = await callBridge("game.legal_actions", {});
    const actions = legalActionsFrom(legal);
    if (actions.length === 0) {
      steps.push({ index: i, ok: false, stopped: true, reason: "no_legal_actions", legalActions: legal });
      return { ok: args?.stopOnNoActions !== false, stopped: true, reason: "no_legal_actions", steps };
    }

    const selected = chooseLegalAction(actions, args || {});
    if (!selected) {
      steps.push({ index: i, ok: false, stopped: true, reason: "no_matching_action", legalActions: legal });
      return { ok: false, stopped: true, reason: "no_matching_action", steps };
    }

    const policy = evaluateActionPolicy(selected, args || {});
    if (!policy.ok) {
      steps.push({ index: i, ok: false, stopped: true, reason: "action_policy_denied", selected, policy, legalActions: legal });
      return { ok: false, stopped: true, reason: "action_policy_denied", steps };
    }

    const stopReason = stopReasonForAction(selected, args || {});
    if (stopReason) {
      steps.push({ index: i, ok: true, stopped: true, reason: stopReason, selected, policy, legalActions: legal });
      return { ok: true, stopped: true, reason: stopReason, steps };
    }

    const actionId = actionValue(selected, "Id");
    if (!actionId) {
      steps.push({ index: i, ok: false, stopped: true, reason: "selected_action_has_no_id", selected, legalActions: legal });
      return { ok: false, stopped: true, reason: "selected_action_has_no_id", steps };
    }

    const step = {
      index: i,
      ok: true,
      dryRun: !!args?.dryRun,
      selected,
      policy
    };
    if (args?.includeSnapshots) {
      step.before = await collectGameSnapshot({ includeHidden: false, onlyInteractive: true });
    }
    if (args?.dryRun) {
      step.result = { ok: true, skipped: true, actionId };
      steps.push(step);
      return { ok: true, stopped: true, reason: "dry_run", steps };
    }

    step.result = await callBridge("game.perform_action", { actionId });
    step.ok = step.result?.ok !== false;
    if (args?.includeSnapshots) {
      step.after = await collectGameSnapshot({ includeHidden: false, onlyInteractive: true });
    }
    steps.push(step);
    if (!step.ok) {
      return { ok: false, stopped: true, reason: "action_failed", steps };
    }
    if (waitAfterMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitAfterMs));
    }
  }

  return { ok: true, stopped: true, reason: "max_steps", steps };
}

function selectLegalAction(actions, selector) {
  if (Number.isInteger(selector.index)) {
    return actions[selector.index] || null;
  }

  const contains = selector.contains !== false;
  return actions.find(action => {
    if (selector.actionId && !matchesText(action.Id || action.id, selector.actionId, contains)) return false;
    if (selector.label && !matchesText(action.Label || action.label, selector.label, contains)) return false;
    if (selector.kind && !matchesText(action.Kind || action.kind, selector.kind, contains)) return false;
    return !!(selector.actionId || selector.label || selector.kind);
  }) || null;
}

function legalActionsFrom(legal) {
  const actions = legal?.data?.Actions || legal?.data?.actions || legal?.Actions || legal?.actions || [];
  return Array.isArray(actions) ? actions : [];
}

function arrayValue(obj, pascalName) {
  const camelName = pascalName.slice(0, 1).toLowerCase() + pascalName.slice(1);
  const value = obj?.[pascalName] ?? obj?.[camelName] ?? [];
  return Array.isArray(value) ? value : [];
}

function hasAction(item, actionName) {
  const actions = item?.SupportedActions ?? item?.supportedActions ?? [];
  return Array.isArray(actions) && actions.some(action => matchesText(action, actionName, false));
}

function limit(value, defaultValue) {
  return Math.max(0, Math.min(200, Number(value ?? defaultValue)));
}

function chooseLegalAction(actions, policy) {
  const candidates = actions
    .map((action, index) => {
      const actionPolicy = evaluateActionPolicy(action, policy || {});
      return {
        action,
        index,
        policy: actionPolicy,
        score: actionPolicy.ok ? actionScore(action, policy || {}) : Number.NEGATIVE_INFINITY
      };
    })
    .filter(candidate => candidate.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0]?.action || null;
}

function actionScore(action, policy) {
  const id = actionValue(action, "Id");
  const kind = actionValue(action, "Kind");
  const label = actionValue(action, "Label");
  if (matchesAny(kind, policy.avoidKinds, true) || matchesAny(label, policy.avoidLabels, true)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (matchesAny(kind, policy.preferKinds, true)) score += 20;
  if (matchesAny(label, policy.preferLabels, true)) score += 10;
  if (id) score += 1;
  return score;
}

function evaluateActionPolicy(action, policy) {
  const id = actionValue(action, "Id");
  const kind = actionValue(action, "Kind");
  const label = actionValue(action, "Label");
  const deniedBy = [];
  const missingAllow = [];

  if (matchesAny(id, policy.denyActionIds, false)) deniedBy.push("denyActionIds");
  if (matchesAny(kind, policy.denyKinds, true)) deniedBy.push("denyKinds");
  if (matchesAny(label, policy.denyLabels, true)) deniedBy.push("denyLabels");
  if (Array.isArray(policy.allowActionIds) && policy.allowActionIds.length > 0 && !matchesAny(id, policy.allowActionIds, false)) missingAllow.push("allowActionIds");
  if (Array.isArray(policy.allowKinds) && policy.allowKinds.length > 0 && !matchesAny(kind, policy.allowKinds, true)) missingAllow.push("allowKinds");
  if (Array.isArray(policy.allowLabels) && policy.allowLabels.length > 0 && !matchesAny(label, policy.allowLabels, true)) missingAllow.push("allowLabels");

  return {
    ok: deniedBy.length === 0 && missingAllow.length === 0,
    id,
    kind,
    label,
    deniedBy,
    missingAllow
  };
}

function stopReasonForAction(action, policy) {
  const id = actionValue(action, "Id");
  const kind = actionValue(action, "Kind");
  const label = actionValue(action, "Label");
  if (matchesAny(id, policy.stopOnActionIds, false)) return "stop_action_id";
  if (matchesAny(kind, policy.stopOnKinds, true)) return "stop_kind";
  if (matchesAny(label, policy.stopOnLabels, true)) return "stop_label";
  return null;
}

function actionValue(action, pascalName) {
  return fieldValue(action, pascalName);
}

function fieldValue(obj, pascalName) {
  if (!obj) return null;
  const camelName = pascalName.slice(0, 1).toLowerCase() + pascalName.slice(1);
  return obj[pascalName] ?? obj[camelName] ?? null;
}

function matchesAny(value, expectedList, contains) {
  if (!Array.isArray(expectedList) || expectedList.length === 0) return false;
  return expectedList.some(expected => matchesText(value, expected, contains));
}

function matchesText(value, expected, contains) {
  if (typeof value !== "string" || typeof expected !== "string") return false;
  const left = value.toLocaleLowerCase();
  const right = expected.toLocaleLowerCase();
  return contains ? left.includes(right) : left === right;
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

let inputBuffer = Buffer.alloc(0);
let contentLength = null;
process.stdin.on("data", chunk => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  while (true) {
    if (contentLength === null) {
      const headerEnd = inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = inputBuffer.subarray(0, newline).toString("utf8").trim();
        if (!line.startsWith("{")) {
          break;
        }
        inputBuffer = inputBuffer.subarray(newline + 1);
        dispatchLine(line);
        continue;
      }
      const header = inputBuffer.subarray(0, headerEnd).toString("ascii");
      inputBuffer = inputBuffer.subarray(headerEnd + 4);
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Missing Content-Length header" } });
        continue;
      }
      contentLength = Number(match[1]);
    }

    if (inputBuffer.length < contentLength) break;
    const body = inputBuffer.subarray(0, contentLength).toString("utf8");
    inputBuffer = inputBuffer.subarray(contentLength);
    contentLength = null;
    dispatchLine(body);
  }
});

function dispatchLine(line) {
  if (!line) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error.message || error) } });
    return;
  }
  Promise.resolve(handleRequest(request))
    .then(response => {
      if (response) send(response);
    })
    .catch(error => {
      send({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32000, message: String(error.message || error) }
      });
    });
}
