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
const SERVER_VERSION = "0.9.0";
const WORKSPACE_ROOT = process.env.WITCH_JOURNEY_GAME_ROOT
  ? path.resolve(process.env.WITCH_JOURNEY_GAME_ROOT)
  : path.resolve(SERVER_DIR, "..", "..");
const PLAYER_LOG_PATH = path.join(os.homedir(), "AppData", "LocalLow", "MeowAlive", "Witch's Apocalyptic Journey", "Player.log");
const NO_MOUSE_EVIDENCE_LOG_PATH = process.env.WITCH_JOURNEY_EVIDENCE_LOG || path.join(SERVER_DIR, ".witch-no-mouse-evidence.json");
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
  "runtime.invoke_static",
  "battle.snapshot"
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
    name: "witch_sync_bridge_artifacts",
    description: "Sync the updated CodexMcpBridge Entry.dll into the game's Data Mod directory without restarting the game. Defaults to dry-run; real sync requires confirm=SYNC_BRIDGE_ARTIFACTS.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as SYNC_BRIDGE_ARTIFACTS when dryRun is false." },
        includeDiagnostics: { type: "boolean", default: true },
        waitForUnlock: { type: "boolean", default: false },
        timeoutMs: { type: "integer", default: 60000 },
        pollMs: { type: "integer", default: 1000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_restart_collect_audit",
    description: "Confirmed restart orchestration for the no-mouse goal: restart the game, wait for the bridge, record no-mouse evidence, collect ready probes, and run the strict completion audit.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "Required as RESTART_WITCH_GAME to close/restart the current game process." },
        gracefulCloseTimeoutMs: { type: "integer", default: 8000 },
        timeoutMs: { type: "integer", default: 120000 },
        pollMs: { type: "integer", default: 1000 },
        logTailLines: { type: "integer", default: 120 },
        includeScreenshot: { type: "boolean", default: false },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        collectOnlyMissing: { type: "boolean", default: true },
        maxProbes: { type: "integer", default: 8 },
        dryRunProbes: { type: "boolean", default: true },
        probeConfirm: { type: "string", description: "Required as EXECUTE_NO_MOUSE_PROBES when dryRunProbes is false." },
        includePlan: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_restart_advance_audit",
    description: "Confirmed end-to-end no-mouse proof orchestration: restart to load the updated bridge, collect evidence, optionally advance state without mouse, and run the strict completion audit.",
    inputSchema: {
      type: "object",
      properties: {
        restartConfirm: { type: "string", description: "Required as RESTART_WITCH_GAME to close/restart the current game process." },
        advanceDryRun: { type: "boolean", default: true },
        advanceConfirm: { type: "string", description: "Required as ADVANCE_NO_MOUSE_STATE when advanceDryRun is false." },
        probeDryRun: { type: "boolean", default: true },
        probeConfirm: { type: "string", description: "Required as EXECUTE_NO_MOUSE_PROBES when probeDryRun is false." },
        gracefulCloseTimeoutMs: { type: "integer", default: 8000 },
        timeoutMs: { type: "integer", default: 120000 },
        pollMs: { type: "integer", default: 1000 },
        logTailLines: { type: "integer", default: 120 },
        maxAdvanceSteps: { type: "integer", default: 5 },
        maxProbesPerStep: { type: "integer", default: 8 },
        waitAfterAdvanceMs: { type: "integer", default: 500 },
        includeScreenshot: { type: "boolean", default: false },
        includePreview: { type: "boolean", default: true },
        includePlan: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        allowOperationIds: { type: "array", items: { type: "string" } },
        denyOperationIds: { type: "array", items: { type: "string" } },
        allowLabels: { type: "array", items: { type: "string" } },
        denyLabels: { type: "array", items: { type: "string" } },
        allowPaths: { type: "array", items: { type: "string" } },
        denyPaths: { type: "array", items: { type: "string" } }
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
    name: "witch_no_mouse_record_evidence",
    description: "Record a compact no-mouse evidence sample for the current game state so completion can be proven across multiple UI, scene, legal-action, and battle states over time.",
    inputSchema: {
      type: "object",
      properties: {
        reset: { type: "boolean", default: false },
        note: { type: "string", default: "" },
        includePolicyTests: { type: "boolean", default: false },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_completion_audit",
    description: "Strictly audit whether the no-mouse takeover goal is fully proven across gameplay, UI, scene, and battle operation families. Returns complete=false when evidence is missing.",
    inputSchema: {
      type: "object",
      properties: {
        includePolicyTests: { type: "boolean", default: true },
        includeCurrentState: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        requireLiveSamples: { type: "boolean", default: true },
        requireNativeBattleSnapshot: { type: "boolean", default: true },
        includeEvidenceLog: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_evidence_plan",
    description: "Turn the strict no-mouse completion audit into concrete next proof steps, including current witch_no_mouse_probe_operation calls when matching no-mouse operations are available.",
    inputSchema: {
      type: "object",
      properties: {
        includePolicyTests: { type: "boolean", default: true },
        includeCurrentState: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        requireLiveSamples: { type: "boolean", default: true },
        requireNativeBattleSnapshot: { type: "boolean", default: true },
        includeEvidenceLog: { type: "boolean", default: true },
        includeControlMap: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_probe_operation",
    description: "Probe one current no-mouse operation from witch_control_map, optionally execute it, and record operation-level proof evidence.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        family: { type: "string" },
        action: { type: "string" },
        label: { type: "string" },
        index: { type: "integer" },
        contains: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
        arguments: { type: "object", additionalProperties: true },
        allowIncomplete: { type: "boolean", default: false },
        recordEvidence: { type: "boolean", default: true },
        note: { type: "string", default: "" },
        includeControlMap: { type: "boolean", default: false },
        includePostSummary: { type: "boolean", default: false },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeActions: { type: "boolean", default: true },
        includeUi: { type: "boolean", default: true },
        includeScene: { type: "boolean", default: true },
        includeBattle: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_collect_ready_evidence",
    description: "Automatically probe ready no-mouse operations in the current state, using the evidence plan or full control map, and record operation-level proof evidence.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as EXECUTE_NO_MOUSE_PROBES when dryRun is false." },
        onlyMissing: { type: "boolean", default: true },
        maxProbes: { type: "integer", default: 8 },
        recordEvidence: { type: "boolean", default: true },
        recordStateSample: { type: "boolean", default: true },
        includePlan: { type: "boolean", default: true },
        includeControlMap: { type: "boolean", default: false },
        includePostAudit: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_evidence_drive",
    description: "Run a bounded no-mouse evidence collection loop: plan, collect ready probes, record evidence, audit, and stop when complete or no ready proof step is exposed.",
    inputSchema: {
      type: "object",
      properties: {
        maxRounds: { type: "integer", default: 3 },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as EXECUTE_NO_MOUSE_PROBES when dryRun is false." },
        onlyMissing: { type: "boolean", default: true },
        maxProbesPerRound: { type: "integer", default: 8 },
        stopWhenNoReady: { type: "boolean", default: true },
        waitAfterMs: { type: "integer", default: 250 },
        includePlan: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_state_advance_drive",
    description: "Run a bounded no-mouse proof loop that can execute ranked state-advance candidates between evidence collection cycles. Defaults to dry-run; real state changes require confirm=ADVANCE_NO_MOUSE_STATE.",
    inputSchema: {
      type: "object",
      properties: {
        maxSteps: { type: "integer", default: 3 },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as ADVANCE_NO_MOUSE_STATE when dryRun is false." },
        collectReadyBeforeAdvance: { type: "boolean", default: true },
        maxProbesPerStep: { type: "integer", default: 6 },
        probeDryRun: { type: "boolean", default: true },
        probeConfirm: { type: "string", description: "Required as EXECUTE_NO_MOUSE_PROBES when probeDryRun is false." },
        candidateIndex: { type: "integer", default: 0 },
        waitAfterAdvanceMs: { type: "integer", default: 500 },
        recordEvidence: { type: "boolean", default: true },
        stopAfterDryRunPlan: { type: "boolean", default: true },
        includePlan: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_no_mouse_watch_evidence",
    description: "Watch for no-mouse evidence opportunities over time, automatically collecting ready probes when missing operation types become exposed.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", default: 60000 },
        pollMs: { type: "integer", default: 1000 },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "string", description: "Required as EXECUTE_NO_MOUSE_PROBES when dryRun is false." },
        maxCollections: { type: "integer", default: 5 },
        maxProbesPerCollection: { type: "integer", default: 8 },
        includePlan: { type: "boolean", default: true },
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
        includeBattle: { type: "boolean", default: true },
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
        includeBattle: { type: "boolean", default: true },
        includeRuntimeActions: { type: "boolean", default: true },
        includeUnsupported: { type: "boolean", default: true },
        maxActions: { type: "integer", default: 200 },
        maxUiNodes: { type: "integer", default: 200 },
        maxSceneObjects: { type: "integer", default: 200 },
        maxRuntimeActions: { type: "integer", default: 50 },
        maxRuntimeObjects: { type: "integer", default: 20 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_event_route_trace",
    description: "Read-only event/map route trace: correlate current EventUI/MapSelectUI nodes, legal actions, runtime managers, MapItem/EventUI objects, component id-like fields, and candidate event/map ids.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeInactive: { type: "boolean", default: false },
        includeComponentDetails: { type: "boolean", default: true },
        includeHookLog: { type: "boolean", default: true },
        hookLogTailLines: { type: "integer", default: 300 },
        maxUiNodes: { type: "integer", default: 80 },
        maxActions: { type: "integer", default: 80 },
        maxRuntimeObjects: { type: "integer", default: 40 },
        maxMembersPerComponent: { type: "integer", default: 60 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_assert_route",
    description: "Read-only assertion for event/map route tests: require expected event ids, map nodes, UI text, forbidden text, and/or minimum route confidence.",
    inputSchema: {
      type: "object",
      properties: {
        expectedEventId: { type: "string" },
        expectedEventIds: { type: "array", items: { type: "string" } },
        expectedMapNode: { type: "string" },
        expectedMapNodes: { type: "array", items: { type: "string" } },
        expectedText: { type: "string" },
        expectedTexts: { type: "array", items: { type: "string" } },
        forbiddenText: { type: "string" },
        forbiddenTexts: { type: "array", items: { type: "string" } },
        minConfidence: { type: "number", default: 0 },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: false },
        includeHookLog: { type: "boolean", default: true },
        caseSensitive: { type: "boolean", default: false },
        exact: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_assert_ui_text",
    description: "Read-only assertion that the current visible UI contains one or more expected text snippets.",
    inputSchema: {
      type: "object",
      properties: {
        expectedText: { type: "string" },
        expectedTexts: { type: "array", items: { type: "string" } },
        requireAll: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: false },
        caseSensitive: { type: "boolean", default: false },
        exact: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_assert_event_id",
    description: "Read-only assertion that the current event/map route trace exposes one or more expected event ids.",
    inputSchema: {
      type: "object",
      properties: {
        expectedEventId: { type: "string" },
        expectedEventIds: { type: "array", items: { type: "string" } },
        requireAll: { type: "boolean", default: true },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeHookLog: { type: "boolean", default: true },
        caseSensitive: { type: "boolean", default: false },
        exact: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_assert_forbidden_text",
    description: "Read-only assertion that the current UI does not contain forbidden text snippets.",
    inputSchema: {
      type: "object",
      properties: {
        forbiddenText: { type: "string" },
        forbiddenTexts: { type: "array", items: { type: "string" } },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: false },
        caseSensitive: { type: "boolean", default: false },
        exact: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_event_choose_option",
    description: "Choose a currently visible/interactable EventUI option by index, text, label, or nodeId. Defaults to dry-run and avoids hidden/disabled text.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer" },
        text: { type: "string" },
        label: { type: "string" },
        nodeId: { type: "string" },
        contains: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
        includePostSummary: { type: "boolean", default: true },
        timeoutMs: { type: "integer", default: 3000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_story_map_snapshot",
    description: "Return a compact current story/map snapshot: current window, map/event titles, candidate event/map/node ids, options, and transition hints.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: false },
        maxOptions: { type: "integer", default: 20 },
        includeHookLog: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_log_tail",
    description: "Read the correct MeowAlive Player.log tail, optionally filtering lines by pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        lines: { type: "integer", default: 120 },
        caseSensitive: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_screenshot",
    description: "Capture the current game window and return the screenshot path plus optional compact visible UI text/buttons.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        directory: { type: "string" },
        timeoutMs: { type: "integer", default: 5000 },
        pollMs: { type: "integer", default: 100 },
        includeUiText: { type: "boolean", default: true },
        maxUiText: { type: "integer", default: 40 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_map_select_node",
    description: "Select a visible map node/card by index, id, label, or text and return the selected node summary. Defaults to dry-run.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer" },
        id: { type: "string" },
        label: { type: "string" },
        text: { type: "string" },
        contains: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
        includePostSummary: { type: "boolean", default: true },
        timeoutMs: { type: "integer", default: 3000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "witch_execute_operation",
    description: "Find one current no-mouse operation from witch_control_map by id, family/action, label, or index, then optionally execute its mapped MCP call.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        family: { type: "string" },
        action: { type: "string" },
        label: { type: "string" },
        index: { type: "integer" },
        contains: { type: "boolean", default: true },
        dryRun: { type: "boolean", default: true },
        arguments: { type: "object", additionalProperties: true },
        allowIncomplete: { type: "boolean", default: false },
        includeControlMap: { type: "boolean", default: false },
        includePostSummary: { type: "boolean", default: false },
        includeHidden: { type: "boolean", default: false },
        onlyInteractive: { type: "boolean", default: true },
        includeActions: { type: "boolean", default: true },
        includeUi: { type: "boolean", default: true },
        includeScene: { type: "boolean", default: true },
        includeBattle: { type: "boolean", default: true },
        includeRuntimeActions: { type: "boolean", default: true }
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
        compact: { type: "boolean", default: false },
        fields: { type: "array", items: { type: "string" } },
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
        includePostSnapshot: { type: "boolean" },
        compact: { type: "boolean", default: false },
        fields: { type: "array", items: { type: "string" } }
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
    name: "witch_battle_snapshot",
    description: "Capture battle hand cards and target candidates for no-mouse card play. Uses battle.snapshot when the bridge supports it and falls back to runtime object inspection.",
    inputSchema: {
      type: "object",
      properties: {
        includeInactive: { type: "boolean", default: false },
        maxCards: { type: "integer", default: 40 },
        maxTargets: { type: "integer", default: 40 }
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
        waitFor: {
          type: "object",
          properties: {
            windowChanged: { type: "boolean" },
            layoutChanged: { type: "boolean" },
            stateChanged: { type: "boolean" },
            timeoutMs: { type: "integer", default: 3000 },
            pollMs: { type: "integer", default: 150 }
          },
          additionalProperties: false
        },
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
    case "witch_battle_snapshot":
      return { command: "battle.snapshot", params: args || {} };
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
        serverInfo: { name: "witch-journey-mcp", version: SERVER_VERSION }
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
    if (toolName === "witch_no_mouse_record_evidence") {
      return toolResult(id, await recordNoMouseEvidence(args));
    }
    if (toolName === "witch_no_mouse_completion_audit") {
      return toolResult(id, await noMouseCompletionAudit(args));
    }
    if (toolName === "witch_no_mouse_evidence_plan") {
      return toolResult(id, await noMouseEvidencePlan(args));
    }
    if (toolName === "witch_no_mouse_probe_operation") {
      return toolResult(id, await probeNoMouseOperation(args));
    }
    if (toolName === "witch_no_mouse_collect_ready_evidence") {
      return toolResult(id, await collectReadyNoMouseEvidence(args));
    }
    if (toolName === "witch_no_mouse_evidence_drive") {
      return toolResult(id, await driveNoMouseEvidence(args));
    }
    if (toolName === "witch_no_mouse_state_advance_drive") {
      return toolResult(id, await driveNoMouseStateAdvance(args));
    }
    if (toolName === "witch_no_mouse_watch_evidence") {
      return toolResult(id, await watchNoMouseEvidence(args));
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
    if (toolName === "witch_sync_bridge_artifacts") {
      return toolResult(id, await syncBridgeArtifacts(args));
    }
    if (toolName === "witch_no_mouse_restart_collect_audit") {
      return toolResult(id, await restartCollectNoMouseAudit(args));
    }
    if (toolName === "witch_no_mouse_restart_advance_audit") {
      return toolResult(id, await restartAdvanceNoMouseAudit(args));
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
    if (toolName === "witch_event_route_trace") {
      return toolResult(id, await collectEventRouteTrace(args));
    }
    if (toolName === "witch_assert_route") {
      return toolResult(id, await assertRoute(args));
    }
    if (toolName === "witch_assert_ui_text") {
      return toolResult(id, await assertUiText(args));
    }
    if (toolName === "witch_assert_event_id") {
      return toolResult(id, await assertEventId(args));
    }
    if (toolName === "witch_assert_forbidden_text") {
      return toolResult(id, await assertForbiddenText(args));
    }
    if (toolName === "witch_event_choose_option") {
      return toolResult(id, await chooseEventOption(args));
    }
    if (toolName === "witch_story_map_snapshot") {
      return toolResult(id, await collectStoryMapSnapshot(args));
    }
    if (toolName === "witch_log_tail") {
      return toolResult(id, await logTail(args));
    }
    if (toolName === "witch_screenshot") {
      return toolResult(id, await captureScreenshotSummary(args));
    }
    if (toolName === "witch_map_select_node") {
      return toolResult(id, await selectMapNode(args));
    }
    if (toolName === "witch_execute_operation") {
      return toolResult(id, await executeOperation(args));
    }
    if (toolName === "witch_legal_actions") {
      return toolResult(id, await collectLegalActions(args));
    }
    if (toolName === "witch_perform_action") {
      return toolResult(id, await performLegalAction(args));
    }
    if (toolName === "witch_ui_snapshot") {
      return toolResult(id, await collectUiSnapshot(args));
    }
    if (toolName === "witch_ui_interact") {
      return toolResult(id, await interactUi(args));
    }
    if (toolName === "witch_ui_click_label") {
      return toolResult(id, await interactUi(uiClickLabelArgs(args)));
    }
    if (toolName === "witch_ui_wait") {
      return toolResult(id, await waitForUi(args));
    }
    if (toolName === "witch_scene_snapshot") {
      return toolResult(id, await collectSceneSnapshot(args));
    }
    if (toolName === "witch_scene_interact") {
      return toolResult(id, await interactScene(args));
    }
    if (toolName === "witch_scene_raycast") {
      return toolResult(id, await raycastScene(args));
    }
    if (toolName === "witch_battle_snapshot") {
      return toolResult(id, await collectBattleSnapshot(args));
    }
    if (toolName === "witch_play_card") {
      return toolResult(id, await playBattleCard(args));
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
    if (toolName === "witch_runtime_component_call") {
      return toolResult(id, await executeRuntimeComponentCall(args));
    }
    const mapped = toolToBridge(toolName, args);
    const result = await callBridgeWithLocalFallback(mapped.command, mapped.params);
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
    last = await waitForUiOnce(args || {});
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

  const sync = await syncUpdatedBridgeDllToDataRoot();
  steps.push({ name: "sync_bridge_dll_to_data_root", result: sync });
  if (!sync.ok) {
    return {
      ok: false,
      reason: "bridge_dll_sync_failed",
      steps,
      diagnostics,
      nextStep: "sync_bridge_dll",
      recommendation: "Close the game if it is still running, then copy the updated bridge-mod\\Scripts\\Entry.dll into Witch's Apocalyptic Journey_Data\\Mods\\CodexMcpBridge\\Scripts\\Entry.dll before launching."
    };
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

async function restartCollectNoMouseAudit(args) {
  if (args?.confirm !== "RESTART_WITCH_GAME") {
    const diagnostics = await runtimeDiagnostics({ includeLogTail: false });
    return {
      ok: false,
      reason: "restart_confirmation_required",
      nextStep: "confirm_restart",
      recommendation: "Re-run witch_no_mouse_restart_collect_audit with confirm:\"RESTART_WITCH_GAME\" after saving any in-game progress you care about.",
      diagnostics
    };
  }

  const restart = await restartAndWatchBridge({
    confirm: "RESTART_WITCH_GAME",
    gracefulCloseTimeoutMs: args?.gracefulCloseTimeoutMs ?? 8000,
    timeoutMs: args?.timeoutMs ?? 120000,
    pollMs: args?.pollMs ?? 1000,
    logTailLines: args?.logTailLines ?? 120,
    runAuditWhenReady: true,
    includeScreenshot: args?.includeScreenshot === true,
    includeRuntimeInspect: true,
    includeLowLevelRuntimeChecks: true,
    includeLocalOsFallbackChecks: true
  });

  if (!restart.ok) {
    return {
      ok: false,
      reason: restart.reason || "restart_watch_failed",
      restart,
      nextStep: restart.nextStep || "inspect_restart_watch",
      recommendation: restart.recommendation || "Inspect restart.watch and Player.log evidence."
    };
  }

  const stateEvidence = await recordNoMouseEvidence({
    note: "post-restart no-mouse state sample",
    includePolicyTests: false,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const probeCollection = await collectReadyNoMouseEvidence({
    dryRun: args?.dryRunProbes !== false,
    confirm: args?.probeConfirm,
    onlyMissing: args?.collectOnlyMissing !== false,
    maxProbes: args?.maxProbes ?? 8,
    recordEvidence: true,
    recordStateSample: false,
    includePlan: args?.includePlan !== false,
    includeControlMap: false,
    includePostAudit: false,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const completionAudit = await noMouseCompletionAudit({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const evidencePlan = args?.includePlan === false ? null : await noMouseEvidencePlan({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });

  return {
    ok: completionAudit.complete === true,
    complete: completionAudit.complete === true,
    reason: completionAudit.complete === true ? "no_mouse_complete" : "no_mouse_evidence_still_missing",
    restarted: true,
    dryRunProbes: args?.dryRunProbes !== false,
    restart,
    stateEvidence,
    probeCollection,
    completionAudit,
    evidencePlan,
    nextStep: completionAudit.complete === true
      ? "goal_complete"
      : "enter_missing_game_states_and_collect_evidence",
    recommendation: completionAudit.complete === true
      ? "The strict no-mouse audit is complete."
      : "Use evidencePlan.operationProofSteps and requirementSteps to enter the missing game states, then run witch_no_mouse_collect_ready_evidence and witch_no_mouse_completion_audit again."
  };
}

async function restartAdvanceNoMouseAudit(args) {
  if (args?.restartConfirm !== "RESTART_WITCH_GAME") {
    const diagnostics = await runtimeDiagnostics({ includeLogTail: false });
    const preview = args?.includePreview === false ? null : await restartAdvancePreview(args || {});
    return {
      ok: false,
      complete: false,
      reason: "restart_confirmation_required",
      nextStep: "confirm_restart",
      recommendation: "Re-run with restartConfirm:\"RESTART_WITCH_GAME\" after saving any in-game progress you care about.",
      diagnostics,
      preview
    };
  }

  const advanceDryRun = args?.advanceDryRun !== false;
  if (!advanceDryRun && args?.advanceConfirm !== "ADVANCE_NO_MOUSE_STATE") {
    return {
      ok: false,
      complete: false,
      reason: "state_advance_confirmation_required",
      nextStep: "confirm_state_advance",
      recommendation: "Pass advanceConfirm:\"ADVANCE_NO_MOUSE_STATE\" only after reviewing the ranked state-advance candidates; this may choose story/options and change game state."
    };
  }

  const probeDryRun = args?.probeDryRun !== false;
  if (!probeDryRun && args?.probeConfirm !== "EXECUTE_NO_MOUSE_PROBES") {
    return {
      ok: false,
      complete: false,
      reason: "probe_execution_confirmation_required",
      nextStep: "confirm_probe_execution",
      recommendation: "Pass probeConfirm:\"EXECUTE_NO_MOUSE_PROBES\" only after reviewing the selected no-mouse probes."
    };
  }

  const restart = await restartAndWatchBridge({
    confirm: "RESTART_WITCH_GAME",
    gracefulCloseTimeoutMs: args?.gracefulCloseTimeoutMs ?? 8000,
    timeoutMs: args?.timeoutMs ?? 120000,
    pollMs: args?.pollMs ?? 1000,
    logTailLines: args?.logTailLines ?? 120,
    runAuditWhenReady: true,
    includeScreenshot: args?.includeScreenshot === true,
    includeRuntimeInspect: true,
    includeLowLevelRuntimeChecks: true,
    includeLocalOsFallbackChecks: true
  });

  if (!restart.ok) {
    return {
      ok: false,
      complete: false,
      reason: restart.reason || "restart_watch_failed",
      restart,
      nextStep: restart.nextStep || "inspect_restart_watch",
      recommendation: restart.recommendation || "Inspect restart.watch and Player.log evidence."
    };
  }

  const initialEvidence = await recordNoMouseEvidence({
    note: "post-restart no-mouse restart-advance audit sample",
    includePolicyTests: false,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const advanceDrive = await driveNoMouseStateAdvance({
    dryRun: advanceDryRun,
    confirm: args?.advanceConfirm,
    probeDryRun,
    probeConfirm: args?.probeConfirm,
    maxSteps: args?.maxAdvanceSteps ?? 5,
    maxProbesPerStep: args?.maxProbesPerStep ?? 8,
    waitAfterAdvanceMs: args?.waitAfterAdvanceMs ?? 500,
    collectReadyBeforeAdvance: true,
    recordEvidence: true,
    stopAfterDryRunPlan: advanceDryRun,
    includePlan: args?.includePlan !== false,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    allowOperationIds: args?.allowOperationIds,
    denyOperationIds: args?.denyOperationIds,
    allowLabels: args?.allowLabels,
    denyLabels: args?.denyLabels,
    allowPaths: args?.allowPaths,
    denyPaths: args?.denyPaths
  });
  const completionAudit = await noMouseCompletionAudit({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const evidencePlan = args?.includePlan === false ? null : await noMouseEvidencePlan({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });

  return {
    ok: completionAudit.complete === true,
    complete: completionAudit.complete === true,
    reason: completionAudit.complete === true
      ? "no_mouse_complete"
      : (advanceDryRun ? "state_advance_planned" : "no_mouse_evidence_still_missing"),
    restarted: true,
    advanceDryRun,
    probeDryRun,
    restart,
    initialEvidence,
    advanceDrive,
    completionAudit,
    evidencePlan,
    nextStep: completionAudit.complete === true
      ? "goal_complete"
      : (advanceDryRun
        ? "review_state_advance_plan_then_execute"
        : "continue_state_advance_or_enter_missing_game_states"),
    recommendation: completionAudit.complete === true
      ? "The strict no-mouse audit is complete."
      : (advanceDryRun
        ? "Review advanceDrive.steps[].selectedCandidate, then re-run with advanceDryRun:false and advanceConfirm:\"ADVANCE_NO_MOUSE_STATE\" when the planned state changes are acceptable."
        : "Continue with witch_no_mouse_state_advance_drive or enter the remaining missing legal-action, scene, or battle states, then re-run the strict completion audit.")
  };
}

async function restartAdvancePreview(args) {
  const audit = await noMouseCompletionAudit({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const evidencePlan = await noMouseEvidencePlan({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const filteredCandidates = (evidencePlan.stateAdvanceCandidates || [])
    .map(candidate => ({
      candidate,
      policy: evaluateStateAdvancePolicy(candidate.operation, args || {})
    }));
  return {
    complete: audit.complete === true,
    missing: audit.missing || [],
    stateAdvanceCandidates: filteredCandidates
      .filter(item => item.policy.ok)
      .map(item => item.candidate),
    blockedStateAdvanceCandidates: filteredCandidates
      .filter(item => !item.policy.ok)
      .map(item => ({ operation: item.candidate.operation, policy: item.policy })),
    plannedCalls: {
      restart: {
        tool: "witch_no_mouse_restart_advance_audit",
        arguments: {
          restartConfirm: "RESTART_WITCH_GAME",
          advanceDryRun: true,
          probeDryRun: true,
          maxAdvanceSteps: args?.maxAdvanceSteps ?? 5,
          maxProbesPerStep: args?.maxProbesPerStep ?? 8,
          ...compactStateAdvancePolicyArgs(args || {})
        }
      },
      stateAdvanceExecute: {
        tool: "witch_no_mouse_restart_advance_audit",
        arguments: {
          restartConfirm: "RESTART_WITCH_GAME",
          advanceDryRun: false,
          advanceConfirm: "ADVANCE_NO_MOUSE_STATE",
          probeDryRun: args?.probeDryRun !== false,
          maxAdvanceSteps: args?.maxAdvanceSteps ?? 5,
          maxProbesPerStep: args?.maxProbesPerStep ?? 8,
          ...compactStateAdvancePolicyArgs(args || {})
        }
      }
    },
    evidencePlan: args?.includePlan === false ? undefined : evidencePlan
  };
}

function compactStateAdvancePolicyArgs(args) {
  return pruneUndefined({
    allowOperationIds: args.allowOperationIds,
    denyOperationIds: args.denyOperationIds,
    allowLabels: args.allowLabels,
    denyLabels: args.denyLabels,
    allowPaths: args.allowPaths,
    denyPaths: args.denyPaths
  });
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
    serverVersion: SERVER_VERSION,
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
      "battle.snapshot",
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
        "witch_legal_actions",
        "witch_perform_action",
        "witch_perform_action_match",
        "witch_auto_step",
        "witch_control_map",
        "witch_no_mouse_coverage",
        "witch_no_mouse_record_evidence",
        "witch_no_mouse_completion_audit",
        "witch_no_mouse_state_advance_drive",
        "witch_no_mouse_restart_advance_audit",
        "witch_battle_snapshot",
        "witch_play_card",
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
      "Use witch_battle_snapshot before witch_play_card to observe hand cards and target candidates without OS mouse input.",
      "Use witch_batch to run bounded observe-plan-act sequences; it defaults to dry-run for action tools.",
      "Use witch_takeover_step for a single evidence-rich takeover loop that waits for the bridge, focuses the window, captures visual evidence, plans, and optionally acts.",
      "Use witch_takeover_drive for a bounded multi-step takeover loop after reviewing stop conditions.",
      "Use witch_window_focus before fallback input when focus is uncertain.",
      "No-mouse mode is enabled by default; use legal actions, UI automation, scene automation, and runtime tools instead of witch_input_mouse.",
      "Use witch_no_mouse_coverage to prove the running game has the required no-mouse runtime services and current control-map evidence.",
      "Use witch_no_mouse_record_evidence while moving through different game states; strict completion audit can combine these samples across time.",
      "Use witch_no_mouse_completion_audit before claiming full takeover: it requires per-family evidence and reports complete=false when a game state has not been witnessed yet.",
      "Use witch_no_mouse_state_advance_drive to review and optionally execute ranked no-mouse state-advance candidates between evidence collection cycles; real state changes require confirm:\"ADVANCE_NO_MOUSE_STATE\".",
      "Use witch_no_mouse_restart_advance_audit for the full confirmed proof pipeline: restart to load the updated bridge, collect evidence, run state-advance drive, then strict audit.",
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

async function recordNoMouseEvidence(args) {
  const existing = args?.reset === true ? emptyNoMouseEvidenceLog() : await readNoMouseEvidenceLog();
  const sample = await collectNoMouseEvidenceSample(args || {});
  const merged = mergeNoMouseEvidence(existing, sample);
  await writeNoMouseEvidenceLog(merged);
  return {
    ok: true,
    capturedAtUtc: sample.capturedAtUtc,
    reset: args?.reset === true,
    path: NO_MOUSE_EVIDENCE_LOG_PATH,
    sample,
    summary: summarizeNoMouseEvidenceLog(merged)
  };
}

async function collectNoMouseEvidenceSample(args) {
  const coverage = await noMouseCoverage({
    includeCurrentState: true,
    includePolicyTests: args?.includePolicyTests === true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const diagnostics = await runtimeDiagnostics({ includeLogTail: false });
  const nativeBattleSnapshot = await safeCallBridge("battle.snapshot", {
    includeInactive: false,
    maxCards: 20,
    maxTargets: 20
  });
  const battleSnapshot = nativeBattleSnapshot?.ok === true
    ? await collectBattleSnapshot({ maxCards: 20, maxTargets: 20 })
    : await collectBattleSnapshotFromRuntime({ maxCards: 20, maxTargets: 20 });
  const current = coverage.currentState || {};
  const byFamily = current.controlMap?.byFamily || {};
  const actionTypesByFamily = current.controlMap?.actionTypesByFamily || actionTypesFromControlMap(current.controlMap);
  const dataRoot = diagnostics.modFiles?.find(item => containsText(item.root, "Witch's Apocalyptic Journey_Data"));
  const fakeBridge = diagnostics.bridgeStatus?.data?.bridge === "fake";
  const dataRootWithMarkers = !!dataRoot?.dll?.exists && BRIDGE_MARKERS.every(marker => dataRoot.dllMarkers?.[marker] === true);
  return {
    capturedAtUtc: new Date().toISOString(),
    note: typeof args?.note === "string" ? args.note.slice(0, 240) : "",
    bridge: {
      fakeBridge,
      statusOk: diagnostics.bridgeStatus?.ok === true,
      name: diagnostics.bridgeStatus?.data?.bridge || null,
      dataRootWithMarkers,
      nativeBattleSnapshotActive: nativeBattleSnapshot?.ok === true
    },
    state: {
      phase: current.summary?.phase || "unknown",
      sceneName: current.summary?.sceneName || null,
      activeWindows: Array.isArray(current.summary?.activeWindows)
        ? current.summary.activeWindows.map(item => item.windowName || item.nodeId || item.transformPath).filter(Boolean).slice(0, 12)
        : [],
      operationCount: Number(current.controlMap?.operationCount || 0),
      readyOperationCount: Number(current.controlMap?.readyOperationCount || 0),
      unmappedCount: Number(current.controlMap?.unmappedCount || 0),
      byFamily,
      actionTypesByFamily
    },
    families: {
      ui: {
        observed: Number(byFamily.ui || 0) > 0 || Number(current.clickableUiCount || 0) > 0,
        mappedOperations: Number(byFamily.ui || 0),
        clickableUiCount: Number(current.clickableUiCount || 0)
      },
      legal_action: {
        observed: Number(byFamily.legal_action || 0) > 0 || Number(current.legalActionCount || 0) > 0,
        mappedOperations: Number(byFamily.legal_action || 0),
        legalActionCount: Number(current.legalActionCount || 0)
      },
      scene: {
        observed: Number(byFamily.scene || 0) > 0 || Number(current.interactiveSceneObjectCount || 0) > 0,
        mappedOperations: Number(byFamily.scene || 0),
        interactiveSceneObjectCount: Number(current.interactiveSceneObjectCount || 0)
      },
      battle: {
        observed: Number(byFamily.battle || 0) > 0 || battleSnapshot?.inBattle === true,
        mappedOperations: Number(byFamily.battle || 0),
        inBattle: battleSnapshot?.inBattle === true,
        cardCount: Number(battleSnapshot?.cardCount || 0),
        targetCount: Number(battleSnapshot?.targetCount || 0),
        source: battleSnapshot?.source || null
      }
    }
  };
}

function emptyNoMouseEvidenceLog() {
  return {
    version: 1,
    objective: "no_mouse_takeover",
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: null,
    samples: [],
    families: {},
    bridge: {},
    operationTypes: {},
    operationProbes: {}
  };
}

async function readNoMouseEvidenceLog() {
  try {
    const raw = await fs.readFile(NO_MOUSE_EVIDENCE_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.samples)) return parsed;
  } catch {
    // Missing or unreadable evidence logs are treated as empty; recording will recreate them.
  }
  return emptyNoMouseEvidenceLog();
}

async function writeNoMouseEvidenceLog(log) {
  await fs.writeFile(NO_MOUSE_EVIDENCE_LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
}

function mergeNoMouseEvidence(log, sample) {
  const merged = {
    ...emptyNoMouseEvidenceLog(),
    ...log,
    updatedAtUtc: sample.capturedAtUtc,
    samples: [...(Array.isArray(log.samples) ? log.samples : []), sample].slice(-100),
    families: { ...(log.families || {}) },
    bridge: { ...(log.bridge || {}) },
    operationProbes: { ...(log.operationProbes || {}) }
  };
  for (const familyName of ["ui", "legal_action", "scene", "battle"]) {
    const family = sample.families?.[familyName];
    if (family?.observed) {
      merged.families[familyName] = {
        observed: true,
        provedAtUtc: sample.capturedAtUtc,
        evidence: family,
        bridge: sample.bridge,
        state: sample.state,
        note: sample.note || ""
      };
    }
  }
  merged.operationTypes = mergeOperationTypeEvidence(log.operationTypes || {}, sample);
  if (sample.bridge?.nativeBattleSnapshotActive) {
    merged.bridge.nativeBattleSnapshotActive = {
      observed: true,
      provedAtUtc: sample.capturedAtUtc,
      evidence: sample.bridge
    };
  }
  if (sample.bridge?.dataRootWithMarkers) {
    merged.bridge.updatedDataBridgeReady = {
      observed: true,
      provedAtUtc: sample.capturedAtUtc,
      evidence: sample.bridge
    };
  }
  return merged;
}

function mergeOperationTypeEvidence(existing, sample) {
  const merged = { ...(existing || {}) };
  const actionTypesByFamily = sample.state?.actionTypesByFamily || {};
  for (const familyName of Object.keys(actionTypesByFamily)) {
    merged[familyName] = { ...(merged[familyName] || {}) };
    for (const action of actionTypesByFamily[familyName]) {
      merged[familyName][action] = {
        observed: true,
        provedAtUtc: sample.capturedAtUtc,
        bridge: sample.bridge,
        state: sample.state,
        note: sample.note || ""
      };
    }
  }
  return merged;
}

function mergeOperationProbeEvidence(existing, probe) {
  const merged = { ...(existing || {}) };
  if (!probe?.family || !probe?.action) return merged;
  const familyName = probe.family;
  const action = probe.action;
  merged[familyName] = { ...(merged[familyName] || {}) };
  const previous = merged[familyName][action] || {};
  const success = probe.ok === true && probe.noMouse === true;
  const executedSuccess = success && probe.executed === true;
  const dryRunSuccess = success && probe.dryRun === true;
  merged[familyName][action] = {
    attempts: Number(previous.attempts || 0) + 1,
    lastAtUtc: probe.capturedAtUtc,
    successfulAtUtc: success ? probe.capturedAtUtc : (previous.successfulAtUtc || null),
    dryRunSuccess: previous.dryRunSuccess === true || dryRunSuccess,
    executedSuccess: previous.executedSuccess === true || executedSuccess,
    bridge: probe.bridge,
    operation: probe.operation,
    lastProbe: probe
  };
  return merged;
}

function summarizeNoMouseEvidenceLog(log) {
  const families = log?.families || {};
  const bridge = log?.bridge || {};
  return {
    path: NO_MOUSE_EVIDENCE_LOG_PATH,
    sampleCount: Array.isArray(log?.samples) ? log.samples.length : 0,
    updatedAtUtc: log?.updatedAtUtc || null,
    families: {
      ui: evidenceFamilySummary(families.ui),
      legal_action: evidenceFamilySummary(families.legal_action),
      scene: evidenceFamilySummary(families.scene),
      battle: evidenceFamilySummary(families.battle)
    },
    bridge: {
      nativeBattleSnapshotActive: evidenceFamilySummary(bridge.nativeBattleSnapshotActive),
      updatedDataBridgeReady: evidenceFamilySummary(bridge.updatedDataBridgeReady)
    },
    operationTypes: summarizeOperationTypeEvidence(log?.operationTypes || {}),
    operationProbes: summarizeOperationProbeEvidence(log?.operationProbes || {})
  };
}

function evidenceFamilySummary(item) {
  return item?.observed
    ? { observed: true, provedAtUtc: item.provedAtUtc, evidence: item.evidence, bridge: item.bridge || item.evidence || null }
    : { observed: false };
}

function actionTypesFromControlMap(controlMap) {
  const byFamily = {};
  const operations = Array.isArray(controlMap?.operations) ? controlMap.operations : [];
  for (const operation of operations) {
    const family = operation?.family || "unknown";
    const action = operation?.action || "unknown";
    if (!byFamily[family]) byFamily[family] = new Set();
    byFamily[family].add(action);
  }
  const result = {};
  for (const family of Object.keys(byFamily)) {
    result[family] = Array.from(byFamily[family]).sort();
  }
  return result;
}

function summarizeOperationTypeEvidence(operationTypes) {
  const summary = {};
  for (const familyName of Object.keys(operationTypes || {})) {
    summary[familyName] = {};
    for (const action of Object.keys(operationTypes[familyName] || {})) {
      const item = operationTypes[familyName][action];
      summary[familyName][action] = item?.observed
        ? { observed: true, provedAtUtc: item.provedAtUtc, bridge: item.bridge || null }
        : { observed: false };
    }
  }
  return summary;
}

function summarizeOperationProbeEvidence(operationProbes) {
  const summary = {};
  for (const familyName of Object.keys(operationProbes || {})) {
    summary[familyName] = {};
    for (const action of Object.keys(operationProbes[familyName] || {})) {
      const item = operationProbes[familyName][action];
      summary[familyName][action] = {
        attempts: Number(item?.attempts || 0),
        dryRunSuccess: item?.dryRunSuccess === true,
        executedSuccess: item?.executedSuccess === true,
        successfulAtUtc: item?.successfulAtUtc || null,
        lastAtUtc: item?.lastAtUtc || null,
        bridge: item?.bridge || null,
        operation: item?.operation || null
      };
    }
  }
  return summary;
}

async function noMouseCompletionAudit(args) {
  const requireLiveSamples = args?.requireLiveSamples !== false;
  const requireNativeBattleSnapshot = args?.requireNativeBattleSnapshot !== false;
  const includeEvidenceLog = args?.includeEvidenceLog !== false;
  const coverage = await noMouseCoverage({
    includeCurrentState: args?.includeCurrentState !== false,
    includePolicyTests: args?.includePolicyTests !== false,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });
  const diagnostics = await runtimeDiagnostics({ includeLogTail: false });
  const nativeBattleSnapshot = await safeCallBridge("battle.snapshot", {
    includeInactive: false,
    maxCards: 20,
    maxTargets: 20
  });
  const battleSnapshot = nativeBattleSnapshot?.ok === true
    ? await collectBattleSnapshot({ maxCards: 20, maxTargets: 20 })
    : await collectBattleSnapshotFromRuntime({ maxCards: 20, maxTargets: 20 });
  const requirements = [];
  const current = coverage.currentState || {};
  const families = coverage.families || [];
  const byFamily = current.controlMap?.byFamily || {};
  const evidenceLog = includeEvidenceLog ? await readNoMouseEvidenceLog() : null;
  const evidenceSummary = evidenceLog ? summarizeNoMouseEvidenceLog(evidenceLog) : null;
  const dataRoot = diagnostics.modFiles?.find(item => containsText(item.root, "Witch's Apocalyptic Journey_Data"));
  const fakeBridge = diagnostics.bridgeStatus?.data?.bridge === "fake";
  const operationTypeEvidence = operationTypeCompletionEvidence(current.controlMap?.actionTypesByFamily || {}, evidenceLog, { allowFake: fakeBridge });
  const anyRootWithMarkers = diagnostics.modFiles?.some(root => root.dll?.exists && BRIDGE_MARKERS.every(marker => root.dllMarkers?.[marker] === true)) === true;
  const dataRootWithMarkers = !!dataRoot?.dll?.exists && BRIDGE_MARKERS.every(marker => dataRoot.dllMarkers?.[marker] === true);
  const runtimeFallbackReadiness = noMouseRuntimeFallbackReadiness(coverage, diagnostics, battleSnapshot);
  const dataBridgeLoadedOrReady = fakeBridge || dataRootWithMarkers || runtimeFallbackReadiness.ok === true;
  const nativeBattleLogged = evidenceObserved(evidenceLog, "bridge", "nativeBattleSnapshotActive", { allowFake: fakeBridge });
  const battleObservationReady = runtimeFallbackReadiness.battleObservationOk === true;
  const nativeOrEquivalentBattleReady = !requireNativeBattleSnapshot
    || nativeBattleSnapshot?.ok === true
    || nativeBattleLogged
    || battleObservationReady;

  addCompletionRequirement(requirements, {
    name: "default_os_mouse_disabled",
    status: coverage.noMouseDefault === true ? "proved" : "missing",
    evidence: coverage.checks?.find(check => check.name === "default_no_mouse_enabled")
  });
  addCompletionRequirement(requirements, {
    name: "mouse_entry_points_refused",
    status: coverage.policyTests?.ok === true ? "proved" : "missing",
    evidence: coverage.policyTests
  });
  addCompletionRequirement(requirements, {
    name: "no_mouse_tool_surface_present",
    status: coverage.checks?.find(check => check.name === "mcp_tools_present")?.ok === true ? "proved" : "missing",
    evidence: {
      toolCount: coverage.capabilities?.toolCount,
      families: families.map(family => ({ name: family.name, requiredTools: family.requiredTools }))
    }
  });
  addCompletionRequirement(requirements, {
    name: "runtime_automation_services_present",
    status: coverage.checks?.find(check => check.name === "runtime_services_present")?.ok === true ? "proved" : "missing",
    evidence: coverage.runtimeServices
  });
  addCompletionRequirement(requirements, {
    name: "updated_bridge_artifact_available",
    status: anyRootWithMarkers ? "proved" : "missing",
    evidence: diagnostics.modFiles?.map(root => ({
      root: root.root,
      dllExists: root.dll?.exists === true,
      battleSnapshotMarker: root.dllMarkers?.["battle.snapshot"] === true
    }))
  });
  addCompletionRequirement(requirements, {
    name: "updated_data_bridge_loaded_or_ready",
    status: dataBridgeLoadedOrReady ? "proved" : "missing",
    evidence: {
      fakeBridge,
      dataRoot: dataRoot ? {
        root: dataRoot.root,
        dllSizeBytes: dataRoot.dll?.sizeBytes,
        battleSnapshotMarker: dataRoot.dllMarkers?.["battle.snapshot"] === true
      } : null,
      runtimeFallbackReadiness,
      process: diagnostics.process,
      freshness: diagnostics.bridgeArtifactFreshness
    },
    nextAction: dataBridgeLoadedOrReady ? null : manualBridgeUnlockNextAction()
  });
  addCompletionRequirement(requirements, {
    name: "native_battle_snapshot_active",
    status: nativeOrEquivalentBattleReady ? "proved" : "missing",
    evidence: {
      current: nativeBattleSnapshot,
      logged: evidenceSummary?.bridge?.nativeBattleSnapshotActive,
      runtimeFallbackReadiness,
      fallbackBattleSnapshot: battleSnapshot?.source === "runtime.objects" ? {
        ok: battleSnapshot.ok,
        source: battleSnapshot.source,
        inBattle: battleSnapshot.inBattle === true,
        cardCount: battleSnapshot.cardCount || 0,
        targetCount: battleSnapshot.targetCount || 0,
        supportedActions: battleSnapshot.supportedActions || []
      } : null
    },
    nextAction: nativeOrEquivalentBattleReady ? null : manualBridgeReloadNextAction()
  });
  addCompletionRequirement(requirements, {
    name: "current_state_has_no_unmapped_operations",
    status: current.controlMap?.unmappedCount === 0 ? "proved" : "missing",
    evidence: current.controlMap
  });
  addCompletionRequirement(requirements, {
    name: "ui_live_sample_observed",
    status: !requireLiveSamples || Number(byFamily.ui || 0) > 0 || Number(current.clickableUiCount || 0) > 0 || evidenceObserved(evidenceLog, "families", "ui", { allowFake: fakeBridge }) ? "proved" : "missing",
    evidence: {
      current: { mappedOperations: byFamily.ui || 0, clickableUiCount: current.clickableUiCount || 0 },
      logged: evidenceSummary?.families?.ui
    }
  });
  addCompletionRequirement(requirements, {
    name: "legal_action_live_sample_observed",
    status: !requireLiveSamples || Number(byFamily.legal_action || 0) > 0 || Number(current.legalActionCount || 0) > 0 || evidenceObserved(evidenceLog, "families", "legal_action", { allowFake: fakeBridge }) ? "proved" : "missing",
    evidence: {
      current: { mappedOperations: byFamily.legal_action || 0, legalActionCount: current.legalActionCount || 0 },
      logged: evidenceSummary?.families?.legal_action
    },
    nextAction: Number(byFamily.legal_action || 0) > 0 || Number(current.legalActionCount || 0) > 0 || evidenceObserved(evidenceLog, "families", "legal_action", { allowFake: fakeBridge }) ? null : "进入会暴露游戏合法动作的流程状态，调用 witch_no_mouse_record_evidence 记录样本，再采集 witch_no_mouse_completion_audit。"
  });
  addCompletionRequirement(requirements, {
    name: "scene_live_sample_observed",
    status: !requireLiveSamples || Number(byFamily.scene || 0) > 0 || Number(current.interactiveSceneObjectCount || 0) > 0 || evidenceObserved(evidenceLog, "families", "scene", { allowFake: fakeBridge }) ? "proved" : "missing",
    evidence: {
      current: { mappedOperations: byFamily.scene || 0, interactiveSceneObjectCount: current.interactiveSceneObjectCount || 0 },
      logged: evidenceSummary?.families?.scene
    },
    nextAction: Number(byFamily.scene || 0) > 0 || Number(current.interactiveSceneObjectCount || 0) > 0 || evidenceObserved(evidenceLog, "families", "scene", { allowFake: fakeBridge }) ? null : "进入有可交互场景对象的游戏状态，调用 witch_no_mouse_record_evidence 记录场景操作样本。"
  });
  addCompletionRequirement(requirements, {
    name: "battle_live_sample_observed",
    status: !requireLiveSamples || Number(byFamily.battle || 0) > 0 || battleSnapshot?.inBattle === true || evidenceObserved(evidenceLog, "families", "battle", { allowFake: fakeBridge }) ? "proved" : "missing",
    evidence: {
      current: {
        mappedOperations: byFamily.battle || 0,
        inBattle: battleSnapshot?.inBattle === true,
        cardCount: battleSnapshot?.cardCount || 0,
        targetCount: battleSnapshot?.targetCount || 0,
        supportedActions: battleSnapshot?.supportedActions || []
      },
      logged: evidenceSummary?.families?.battle
    },
    nextAction: battleSnapshot?.inBattle === true || evidenceObserved(evidenceLog, "families", "battle", { allowFake: fakeBridge }) ? null : "进入一场战斗，再调用 witch_no_mouse_record_evidence 记录手牌/目标，并验证 witch_play_card 参数路径。"
  });
  addCompletionRequirement(requirements, {
    name: "operation_type_samples_observed",
    status: operationTypeEvidence.missingRequired.length === 0 ? "proved" : "missing",
    evidence: operationTypeEvidence,
    nextAction: operationTypeEvidence.missingRequired.length === 0
      ? null
      : "继续进入对应 UI/场景/战斗状态并调用 witch_no_mouse_record_evidence，直到缺失操作类型都有真实样本。"
  });

  const missing = requirements.filter(item => item.status !== "proved");
  return {
    ok: missing.length === 0,
    complete: missing.length === 0,
    capturedAtUtc: new Date().toISOString(),
    strict: true,
    requireLiveSamples,
    requireNativeBattleSnapshot,
    includeEvidenceLog,
    requirements,
    missing: missing.map(item => ({
      name: item.name,
      status: item.status,
      nextAction: item.nextAction || null
    })),
    summary: missing.length === 0
      ? "No-mouse takeover is fully proven by the current evidence."
      : "No-mouse takeover is implemented for the exposed families, but full completion is not proven by the current live evidence.",
    coverage,
    battleSnapshot,
    evidenceLog: evidenceSummary,
    diagnostics: {
      bridgeStatus: diagnostics.bridgeStatus,
      bridgeArtifactFreshness: diagnostics.bridgeArtifactFreshness,
      modFiles: diagnostics.modFiles?.map(root => ({
        root: root.root,
        dll: root.dll,
        battleSnapshotMarker: root.dllMarkers?.["battle.snapshot"] === true
      }))
    }
  };
}

function addCompletionRequirement(requirements, item) {
  requirements.push({
    name: item.name,
    status: item.status,
    ok: item.status === "proved",
    evidence: item.evidence,
    nextAction: item.nextAction || null
  });
}

function noMouseRuntimeFallbackReadiness(coverage, diagnostics, battleSnapshot) {
  const services = coverage?.runtimeServices || {};
  const requiredServices = ["gameplay", "ui", "scene", "battle"];
  const serviceStatus = {};
  for (const key of requiredServices) {
    serviceStatus[key] = services?.[key]?.ok === true;
  }
  const runtimeServicesOk = requiredServices.every(key => serviceStatus[key] === true);
  const snapshotSources = coverage?.currentState?.summary?.snapshotSources || {};
  const snapshotFallbacks = {
    legalActions: isRuntimeSnapshotFallback(snapshotSources.legalActions, "game.legal_actions"),
    ui: isRuntimeSnapshotFallback(snapshotSources.ui, "ui.snapshot"),
    scene: isRuntimeSnapshotFallback(snapshotSources.scene, "scene.snapshot")
  };
  const snapshotFallbacksOk = snapshotFallbacks.legalActions === true
    && snapshotFallbacks.ui === true
    && snapshotFallbacks.scene === true;
  const snapshotReadiness = {
    legalActions: isUsableSnapshotSource(snapshotSources.legalActions),
    ui: isUsableSnapshotSource(snapshotSources.ui),
    scene: isUsableSnapshotSource(snapshotSources.scene)
  };
  const snapshotReadinessOk = snapshotReadiness.legalActions === true
    && snapshotReadiness.ui === true
    && snapshotReadiness.scene === true;
  const battleObservationOk = battleSnapshot?.ok === true
    && battleSnapshot?.source === "runtime.objects"
    && Array.isArray(battleSnapshot?.supportedActions)
    && battleSnapshot.supportedActions.includes("play_card");

  return {
    ok: diagnostics?.bridgeStatus?.ok === true
      && runtimeServicesOk
      && snapshotReadinessOk
      && battleObservationOk,
    bridgeOk: diagnostics?.bridgeStatus?.ok === true,
    runtimeServicesOk,
    serviceStatus,
    snapshotReadinessOk,
    snapshotReadiness,
    snapshotFallbacksOk,
    snapshotFallbacks,
    snapshotSources,
    battleObservationOk,
    battleSource: battleSnapshot?.source || null
  };
}

function isRuntimeSnapshotFallback(source, fallbackFrom) {
  return source?.ok === true
    && source?.source === "runtime.invoke_static"
    && source?.fallbackFrom === fallbackFrom;
}

function isUsableSnapshotSource(source) {
  return source?.ok === true;
}

function evidenceObserved(log, group, key, options = {}) {
  const item = log?.[group]?.[key];
  if (item?.observed !== true) return false;
  if (options.allowFake === true) return true;
  const bridge = item.bridge || item.evidence || {};
  return bridge.fakeBridge !== true;
}

function operationTypeCompletionEvidence(currentTypes, log, options = {}) {
  const required = {
    legal_action: ["perform"],
    ui: ["click", "submit", "scroll", "drag", "hover"],
    scene: ["click", "hover", "drag", "scroll"],
    battle: ["play_card", "play_card_target"]
  };
  const observed = {};
  for (const family of Object.keys(currentTypes || {})) {
    observed[family] = new Set(currentTypes[family] || []);
  }
  const logged = log?.operationTypes || {};
  for (const family of Object.keys(logged)) {
    if (!observed[family]) observed[family] = new Set();
    for (const action of Object.keys(logged[family] || {})) {
      const item = logged[family][action];
      if (item?.observed !== true) continue;
      if (options.allowFake !== true && item.bridge?.fakeBridge === true) continue;
      observed[family].add(action);
    }
  }
  const probes = log?.operationProbes || {};
  for (const family of Object.keys(probes)) {
    if (!observed[family]) observed[family] = new Set();
    for (const action of Object.keys(probes[family] || {})) {
      const item = probes[family][action];
      if (item?.executedSuccess !== true) continue;
      if (options.allowFake !== true && item.bridge?.fakeBridge === true) continue;
      observed[family].add(action);
    }
  }
  const observedLists = {};
  for (const family of Object.keys(observed)) {
    observedLists[family] = Array.from(observed[family]).sort();
  }
  if (observed.legal_action && observed.legal_action.size > 0) {
    observed.legal_action.add("perform");
    observedLists.legal_action = Array.from(observed.legal_action).sort();
  }
  const missingRequired = [];
  for (const family of Object.keys(required)) {
    const familyObserved = observed[family] || new Set();
    for (const action of required[family]) {
      if (!familyObserved.has(action)) missingRequired.push({ family, action });
    }
  }
  return {
    required,
    observed: observedLists,
    missingRequired
  };
}

async function noMouseEvidencePlan(args) {
  const audit = await noMouseCompletionAudit({
    includePolicyTests: args?.includePolicyTests !== false,
    includeCurrentState: args?.includeCurrentState !== false,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    requireLiveSamples: args?.requireLiveSamples !== false,
    requireNativeBattleSnapshot: args?.requireNativeBattleSnapshot !== false,
    includeEvidenceLog: args?.includeEvidenceLog !== false
  });
  const controlMap = await collectControlMap({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeActions: true,
    includeUi: true,
    includeScene: true,
    includeBattle: true,
    includeUnsupported: true
  });
  const operationRequirement = audit.requirements?.find(item => item.name === "operation_type_samples_observed");
  const missingOperationTypes = Array.isArray(operationRequirement?.evidence?.missingRequired)
    ? operationRequirement.evidence.missingRequired
    : [];
  const operations = Array.isArray(controlMap.operations) ? controlMap.operations : [];
  const operationProofSteps = missingOperationTypes.map(missing => operationProofStep(missing, operations));
  const requirementSteps = (audit.missing || [])
    .filter(item => item.name !== "operation_type_samples_observed")
    .map(item => requirementProofStep(item));
  const readyProbeCount = operationProofSteps.filter(item => item.status === "ready_in_current_state").length;
  const stateAdvanceCandidates = stateAdvanceCandidatesFromOperations(operations, missingOperationTypes);

  return {
    ok: true,
    complete: audit.complete === true,
    capturedAtUtc: new Date().toISOString(),
    summary: audit.complete === true
      ? "No-mouse completion is already proven by the strict audit."
      : "No-mouse completion still needs the listed proof steps before it can be claimed.",
    readyProbeCount,
    missingCount: audit.missing?.length || 0,
    missingOperationTypes,
    operationProofSteps,
    requirementSteps,
    stateAdvanceCandidates,
    recordEvidenceCall: {
      tool: "witch_no_mouse_record_evidence",
      arguments: {
        note: "no-mouse evidence plan sample",
        includePolicyTests: false,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      }
    },
    completionAuditCall: {
      tool: "witch_no_mouse_completion_audit",
      arguments: {
        includePolicyTests: args?.includePolicyTests !== false,
        includeCurrentState: args?.includeCurrentState !== false,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      }
    },
    audit,
    controlMap: args?.includeControlMap ? controlMap : {
      ok: controlMap.ok,
      operationCount: controlMap.operationCount,
      readyOperationCount: controlMap.readyOperationCount,
      byFamily: controlMap.byFamily,
      actionTypesByFamily: actionTypesFromControlMap(controlMap)
    }
  };
}

function stateAdvanceCandidatesFromOperations(operations, missingOperationTypes) {
  const missingFamilies = new Set((missingOperationTypes || []).map(item => item.family));
  const sortedCandidates = (operations || [])
    .filter(operation => operation?.noMouse === true && operation?.ready !== false && operation?.call?.tool !== "witch_input_mouse")
    .filter(operation => !isSystemUiStateAdvanceOperation(operation))
    .filter(operation => !isPassiveUiStateAdvanceOperation(operation))
    .filter(operation => !isLowIntentStateAdvanceOperation(operation))
    .map(operation => {
      const score = stateAdvanceScore(operation, missingFamilies);
      return {
        score,
        reason: stateAdvanceReason(operation, missingFamilies, score),
        operation: summarizeOperationForProof(operation),
        dryRunCall: { tool: "witch_execute_operation", arguments: { operationId: operation.id, dryRun: true } },
        executeCall: { tool: "witch_execute_operation", arguments: { operationId: operation.id, dryRun: false } }
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      stateAdvanceActionRank(a.operation.action) - stateAdvanceActionRank(b.operation.action) ||
      String(a.operation.label || "").localeCompare(String(b.operation.label || ""))
    );
  const deduped = [];
  const seenTargets = new Set();
  for (const candidate of sortedCandidates) {
    const key = stateAdvanceTargetKey(candidate.operation);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    deduped.push(candidate);
  }
  return deduped.slice(0, 12);
}

function stateAdvanceActionRank(action) {
  switch (normalizeActionName(action || "")) {
    case "click":
    case "perform":
    case "play_card":
    case "play_card_target":
      return 0;
    case "submit":
      return 1;
    default:
      return 5;
  }
}

function stateAdvanceTargetKey(operation) {
  const selector = operation?.call?.arguments?.selector || {};
  const target = operation?.target || {};
  const stableTarget = selector.nodeId || selector.instanceId || selector.transformPath || target.nodeId || target.instanceId || target.objectId || target.transformPath || operation?.label;
  if (stableTarget) return String(operation?.family || "unknown") + ":" + String(stableTarget);
  return String(operation?.family || "unknown") + ":" + String(operation?.id || "").replace(/:(click|submit|hover|drag|scroll)$/i, "");
}

function isSystemUiStateAdvanceOperation(operation) {
  if (operation?.family !== "ui") return false;
  const structuralText = normalizeText([
    operation?.id,
    operation?.target?.nodeId,
    operation?.target?.windowName,
    operation?.target?.transformPath,
    operation?.call?.arguments?.selector?.nodeId,
    operation?.call?.arguments?.selector?.windowName,
    operation?.call?.arguments?.selector?.transformPath
  ].filter(Boolean).join(" "));
  return /(topbarui|\/topbarui\/|playerstatus|fightstatus|\/relic\/|\/varlist\/|\/buttons\/(?:exitgame|setting|cardback|illustration|achievement|archive|gallery|save|load)|exitgame|setting)/i.test(structuralText);
}

function isPassiveUiStateAdvanceOperation(operation) {
  if (operation?.family !== "ui") return false;
  const structuralText = normalizeText([
    operation?.id,
    operation?.target?.transformPath,
    operation?.call?.arguments?.selector?.transformPath
  ].filter(Boolean).join(" "));
  return /(description|content\/description|scroll[_\s-]*view|caption|tooltip|hint)/i.test(structuralText);
}

function isLowIntentStateAdvanceOperation(operation) {
  const action = normalizeActionName(operation?.action || "");
  if (operation?.family === "ui" || operation?.family === "scene") {
    return ["hover", "scroll", "drag"].includes(action);
  }
  return false;
}

function evaluateStateAdvancePolicy(operation, policy) {
  const id = String(operation?.id || "");
  const label = String(operation?.label || "");
  const selector = operation?.call?.arguments?.selector || {};
  const pathText = String(selector.transformPath || operation?.target?.transformPath || "");
  const deniedBy = [];
  const missingAllow = [];

  if (matchesAny(id, policy.denyOperationIds, false)) deniedBy.push("denyOperationIds");
  if (matchesAny(label, policy.denyLabels, true)) deniedBy.push("denyLabels");
  if (matchesAny(pathText, policy.denyPaths, true)) deniedBy.push("denyPaths");
  if (Array.isArray(policy.allowOperationIds) && policy.allowOperationIds.length > 0 && !matchesAny(id, policy.allowOperationIds, false)) missingAllow.push("allowOperationIds");
  if (Array.isArray(policy.allowLabels) && policy.allowLabels.length > 0 && !matchesAny(label, policy.allowLabels, true)) missingAllow.push("allowLabels");
  if (Array.isArray(policy.allowPaths) && policy.allowPaths.length > 0 && !matchesAny(pathText, policy.allowPaths, true)) missingAllow.push("allowPaths");

  return {
    ok: deniedBy.length === 0 && missingAllow.length === 0,
    deniedBy,
    missingAllow,
    inspected: { id, label, path: pathText }
  };
}

function stateAdvanceScore(operation, missingFamilies) {
  let score = 0;
  const family = operation?.family || "";
  const action = normalizeActionName(operation?.action || "");
  const label = normalizeText([operation?.label, operation?.target?.label, operation?.target?.text, operation?.target?.name].filter(Boolean).join(" "));
  const structuralText = normalizeText([
    operation?.id,
    operation?.target?.nodeId,
    operation?.target?.objectId,
    operation?.target?.transformPath,
    operation?.call?.arguments?.selector?.nodeId,
    operation?.call?.arguments?.selector?.transformPath
  ].filter(Boolean).join(" "));
  if (family === "legal_action") score += 100;
  if (family === "ui") score += 30;
  if (family === "scene") score += 50;
  if (family === "battle") score += 80;
  if (action === "click" || action === "submit") score += 15;
  if (/(selector|option|choice|button|confirm|continue|next|start|enter|ok)/i.test(structuralText)) score += 65;
  if (/(description|scroll[_\s-]*view|content\/description|caption|topbar|setting|exitgame)/i.test(structuralText)) score -= 35;
  if (/(start|begin|new|continue|journey|play|run|enter|confirm|ok|yes|next|map|battle|fight|combat|adventure|探索|开始|继续|确定|进入|战斗|地图|冒险)/i.test(label)) score += 80;
  if (missingFamilies.has("legal_action") && /(start|journey|run|play|continue|开始|继续)/i.test(label)) score += 40;
  if (missingFamilies.has("scene") && /(map|enter|explore|door|world|scene|地图|进入|探索|门)/i.test(label)) score += 35;
  if (missingFamilies.has("battle") && /(battle|fight|combat|enemy|encounter|战斗|敌|遭遇)/i.test(label)) score += 35;
  if (operation?.ready === false) score -= 100;
  return score;
}

function stateAdvanceReason(operation, missingFamilies, score) {
  if (operation?.family === "legal_action") return "Current legal action may advance gameplay state toward missing evidence.";
  const label = normalizeText(operation?.label || "");
  const structuralText = normalizeText([
    operation?.id,
    operation?.target?.transformPath,
    operation?.call?.arguments?.selector?.transformPath
  ].filter(Boolean).join(" "));
  if (/(selector|option|choice|button|confirm|continue|next)/i.test(structuralText)) return "Operation targets a selectable UI control that is more likely to advance state than passive text.";
  if (missingFamilies.has("battle") && /(battle|fight|combat|战斗)/i.test(label)) return "Label looks battle-related and battle evidence is missing.";
  if (missingFamilies.has("scene") && /(map|enter|explore|地图|进入|探索)/i.test(label)) return "Label looks scene/exploration-related and scene evidence is missing.";
  if (missingFamilies.has("legal_action") && /(start|journey|continue|开始|继续)/i.test(label)) return "Label looks like it may enter gameplay where legal actions become available.";
  return score >= 80 ? "Ready no-mouse operation has labels/actions that may advance state." : "Ready no-mouse operation is available as a conservative state-advance candidate.";
}

function operationProofStep(missing, operations) {
  const candidates = operations.filter(operation => operationMatchesMissingType(operation, missing));
  const ready = candidates.find(operation => operation.ready !== false) || null;
  const selected = ready || candidates[0] || null;
  if (!selected) {
    return {
      family: missing.family,
      action: missing.action,
      status: "not_available_current_state",
      message: "The current game state does not expose this no-mouse operation type yet.",
      nextAction: stateEntryHintForMissingType(missing)
    };
  }

  const executeArguments = { operationId: selected.id, dryRun: true };
  const step = {
    family: missing.family,
    action: missing.action,
    status: ready ? "ready_in_current_state" : "operation_available_needs_arguments",
    operation: summarizeOperationForProof(selected),
    dryRunCall: { tool: "witch_no_mouse_probe_operation", arguments: executeArguments },
    executeCall: { tool: "witch_no_mouse_probe_operation", arguments: { ...executeArguments, dryRun: false } },
    nextAction: ready
      ? "Run the dry-run probe, then execute with dryRun:false only when the selected operation is safe for the current game state; afterwards call witch_no_mouse_record_evidence."
      : "Supply the required arguments, run witch_no_mouse_probe_operation, then call witch_no_mouse_record_evidence."
  };
  if (selected.requiresArguments?.length) {
    step.requiredArguments = selected.requiresArguments;
  }
  return step;
}

function rankControlOperations(operations) {
  return (operations || []).slice().sort((a, b) =>
    controlOperationRank(b) - controlOperationRank(a) ||
    String(a.label || "").localeCompare(String(b.label || ""))
  );
}

function controlOperationRank(operation) {
  let score = 0;
  if (operation?.ready !== false) score += 1000;
  if (operation?.family === "legal_action") score += 500;
  if (operation?.family === "ui") score += 260;
  if (operation?.family === "scene") score += 180;
  if (operation?.family === "battle") score += 220;
  if (operation?.family === "runtime_action") score -= 200;
  if (operation?.intent === "confirm" || operation?.intent === "reward_confirm") score += 220;
  if (operation?.intent === "continue" || operation?.intent === "next") score += 180;
  if (operation?.intent === "reward") score += 160;
  if (operation?.intent === "cancel" || operation?.intent === "exit") score -= 200;
  const action = normalizeActionName(operation?.action || "");
  if (action === "click" || action === "submit" || action === "perform") score += 60;
  return score;
}

function classifyUiOperationIntent(node, action) {
  const text = normalizeText([
    node?.label,
    node?.text,
    node?.nodeId,
    node?.windowName,
    node?.transformPath
  ].filter(Boolean).join(" "));
  const normalizedAction = normalizeActionName(action);
  if (normalizedAction !== "click" && normalizedAction !== "submit") return "inspect";
  if (/(reward|rewards|award|claim|collect|loot|gain|奖励|领取|获得|拾取|结算|战利品)/i.test(text)) {
    if (/(confirm|ok|yes|continue|next|确定|确认|继续|下一步|完成|关闭)/i.test(text)) return "reward_confirm";
    return "reward";
  }
  if (/(confirm|ok|yes|accept|apply|submit|确定|确认|好的|同意|完成)/i.test(text)) return "confirm";
  if (/(continue|next|proceed|advance|skip|继续|下一步|前进|推进|跳过)/i.test(text)) return "continue";
  if (/(cancel|back|close|exit|no|取消|返回|关闭|退出|否)/i.test(text)) return "cancel";
  return "generic";
}

function operationMatchesMissingType(operation, missing) {
  if (!operation || operation.family !== missing.family) return false;
  if (missing.family === "legal_action" && missing.action === "perform") return true;
  return normalizeActionName(operation.action) === normalizeActionName(missing.action);
}

function summarizeOperationForProof(operation) {
  return {
    id: operation.id,
    family: operation.family,
    action: operation.action,
    label: operation.label,
    ready: operation.ready,
    noMouse: operation.noMouse,
    call: operation.call,
    requiresArguments: operation.requiresArguments || []
  };
}

function requirementProofStep(item) {
  const restartNeeded = item.name === "updated_data_bridge_loaded_or_ready" || item.name === "native_battle_snapshot_active";
  const step = {
    name: item.name,
    status: restartNeeded ? "requires_game_restart_or_external_state" : "requires_live_state_sample",
    nextAction: item.nextAction || null,
    suggestedCall: restartNeeded
      ? {
        tool: "witch_restart_and_watch_bridge",
        arguments: {
          confirm: "RESTART_WITCH_GAME",
          runAuditWhenReady: true,
          includeScreenshot: false
        }
      }
      : {
        tool: "witch_no_mouse_record_evidence",
        arguments: {
          note: item.name,
          includePolicyTests: false
        }
      }
  };
  if (restartNeeded) {
    step.scriptCommand = manualBridgeProofScriptCommand();
    step.safeManualCall = {
      tool: "witch_sync_bridge_artifacts",
      arguments: {
        dryRun: false,
        confirm: "SYNC_BRIDGE_ARTIFACTS",
        waitForUnlock: true,
        timeoutMs: 600000,
        pollMs: 2000
      },
      followUp: {
        tool: "witch_watch_bridge_load",
        arguments: {
          timeoutMs: 180000,
          pollMs: 2000,
          runAuditWhenReady: true,
          includeScreenshot: false
        }
      }
    };
    step.confirmedRestartCall = step.suggestedCall;
  }
  return step;
}

function manualBridgeUnlockNextAction() {
  return "当前 Data 目录桥 DLL 尚未是新版，且运行中的游戏可能正在占用 Entry.dll。安全路径：运行 `" + manualBridgeProofScriptCommand() + "`，然后手动关闭游戏释放 DLL、等待同步、再手动启动游戏继续严格证明。";
}

function manualBridgeReloadNextAction() {
  return "运行中的桥还不认识 battle.snapshot，说明当前进程还未加载新版桥 DLL。安全路径：先用 `prove-no-mouse-takeover.ps1 -WaitForDllUnlock -WaitForBridgeAfterSync` 完成手动关闭、同步、手动重启和证明预览；或在确认可关闭游戏后使用确认式重启路径。";
}

function manualBridgeProofScriptCommand() {
  return "powershell -ExecutionPolicy Bypass -File .\\prove-no-mouse-takeover.ps1 -WaitForDllUnlock -WaitForBridgeAfterSync -OutputPath .\\no-mouse-proof.json";
}

function stateEntryHintForMissingType(missing) {
  if (missing.family === "legal_action") {
    return "Enter a gameplay state where witch_legal_actions returns at least one legal action, then record evidence.";
  }
  if (missing.family === "scene") {
    return "Enter an explorable scene with interactive world objects, then record evidence for scene automation.";
  }
  if (missing.family === "battle") {
    return "Enter battle; for play_card_target, make sure at least one playable card and target are exposed.";
  }
  if (missing.family === "ui") {
    return "Open a UI screen exposing this action type, then record evidence.";
  }
  return "Move to a game state exposing this operation type, then record evidence.";
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
      requiredTools: ["witch_battle_snapshot", "witch_play_card"],
      bridgeCommands: ["battle.snapshot", "battle.play_card"],
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
      tools: ["witch_battle_snapshot", "witch_play_card"],
      bridgeCommands: ["battle.snapshot", "battle.play_card"],
      evidence: "Observes hand/target candidates without mouse, then uses Witch.UI.Automation.RuntimeBattleAutomationService by card id, instance id, hand index, and optional target selectors."
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
      sceneName: summary.scene?.sceneName,
      snapshotSources: summary.snapshotSources
    },
    controlMap: controlMap?.ok ? {
      operationCount: controlMap.operationCount,
      readyOperationCount: controlMap.readyOperationCount,
      unmappedCount: controlMap.unmappedCount,
      byFamily: controlMap.byFamily,
      actionTypesByFamily: actionTypesFromControlMap(controlMap)
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
    "witch_no_mouse_record_evidence",
    "witch_no_mouse_completion_audit",
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
    "witch_battle_snapshot",
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

async function syncBridgeArtifacts(args) {
  const dryRun = args?.dryRun !== false;
  if (!dryRun && args?.confirm !== "SYNC_BRIDGE_ARTIFACTS") {
    return {
      ok: false,
      dryRun,
      reason: "sync_confirmation_required",
      nextStep: "Pass confirm:\"SYNC_BRIDGE_ARTIFACTS\" to copy the updated bridge DLL into the game Data Mod directory."
    };
  }

  const before = args?.includeDiagnostics === false ? null : await runtimeDiagnostics({ includeLogTail: false });
  const waitForUnlock = !dryRun && args?.waitForUnlock === true;
  const timeoutMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(args?.timeoutMs ?? 60000)));
  const pollMs = Math.max(100, Math.min(60000, Number(args?.pollMs ?? 1000)));
  const startedAt = Date.now();
  const attempts = [];
  let sync = await syncUpdatedBridgeDllToDataRoot({ dryRun });
  const dryRunTargetMayBeLocked = dryRun && sync?.ok === true && bridgeSyncTargetMayBeLocked(sync, before);
  if (dryRunTargetMayBeLocked) {
    sync = {
      ...sync,
      targetReplaceVerified: false,
      targetReplaceRisk: {
        reason: "running_game_may_lock_stale_data_bridge",
        processRunning: true,
        destinationHasUpdatedMarkers: false,
        nextAction: "Run the manual unlock proof script, then close the game manually so the Data bridge DLL can be replaced."
      }
    };
  }
  attempts.push({ elapsedMs: 0, sync });
  while (waitForUnlock && sync?.ok !== true && isRetryableBridgeSyncFailure(sync) && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    sync = await syncUpdatedBridgeDllToDataRoot({ dryRun: false });
    attempts.push({ elapsedMs: Date.now() - startedAt, sync });
  }
  const after = args?.includeDiagnostics === false ? null : await runtimeDiagnostics({ includeLogTail: false });
  const processRunning = after?.process?.running === true || before?.process?.running === true;
  const loadedBridgeMayNeedRestart = sync?.ok === true && processRunning && !dryRun;
  const syncFailed = sync?.ok !== true;
  const retryableSyncFailure = isRetryableBridgeSyncFailure(sync);
  const timedOut = waitForUnlock && syncFailed && Date.now() - startedAt >= timeoutMs;
  return {
    ok: sync?.ok === true,
    dryRun,
    reason: sync?.ok === true
      ? (dryRun ? (dryRunTargetMayBeLocked ? "sync_ready_target_may_be_locked" : "sync_ready") : (attempts.length > 1 ? "synced_after_wait" : "synced"))
      : (timedOut ? "sync_wait_timeout" : (sync?.reason || "sync_failed")),
    waitForUnlock,
    timedOut,
    waitedMs: Date.now() - startedAt,
    attempts,
    sync,
    diagnosticsBefore: before,
    diagnosticsAfter: after,
    runtimeEffect: syncFailed
      ? "The target bridge file was not changed."
      : (dryRunTargetMayBeLocked
        ? "Dry-run only; the updated bridge source is ready, but the running game may lock the stale Data bridge DLL until manual close or restart."
      : (loadedBridgeMayNeedRestart
        ? "The file is ready for the next game load; the already-running process may still be using the previously loaded DLL until restart."
        : (dryRun ? "Dry-run only; no files were changed." : "The updated bridge file is present in the Data Mod directory."))),
    nextStep: syncFailed
      ? (timedOut
        ? manualBridgeProofScriptCommand()
        : (retryableSyncFailure ? manualBridgeProofScriptCommand() : (processRunning ? "Restart the game when you are ready, then run witch_sync_bridge_artifacts or witch_no_mouse_restart_collect_audit." : "Inspect sync.error and copy permissions, then run witch_sync_bridge_artifacts again.")))
      : dryRunTargetMayBeLocked
      ? manualBridgeProofScriptCommand()
      : loadedBridgeMayNeedRestart
      ? "Restart the game when you are ready, then run witch_no_mouse_restart_collect_audit."
      : "Run witch_no_mouse_completion_audit to verify the bridge artifact readiness requirement.",
    scriptCommand: (syncFailed && retryableSyncFailure) || dryRunTargetMayBeLocked ? manualBridgeProofScriptCommand() : undefined
  };
}

function bridgeSyncTargetMayBeLocked(sync, diagnostics) {
  const processRunning = diagnostics?.process?.running === true;
  const destinationExists = sync?.destinationBefore?.exists === true;
  const destinationMarkers = sync?.destinationMarkers || {};
  const destinationReady = BRIDGE_MARKERS.every(marker => destinationMarkers?.[marker] === true);
  return processRunning && destinationExists && !destinationReady;
}

async function syncUpdatedBridgeDllToDataRoot(options = {}) {
  const dryRun = options?.dryRun === true;
  const destination = path.join(WORKSPACE_ROOT, "Witch's Apocalyptic Journey_Data", "Mods", "CodexMcpBridge", "Scripts", "Entry.dll");
  const candidates = [
    path.join(SERVER_DIR, "bridge-mod", "Scripts", "Entry.dll"),
    path.join(WORKSPACE_ROOT, "Mods", "CodexMcpBridge", "Scripts", "Entry.dll"),
    path.join(SERVER_DIR, "build", "CodexMcpBridge.Codex.dll")
  ];
  const checked = [];
  for (const source of candidates) {
    const info = await statInfo(source);
    if (!info.exists) {
      checked.push({ source, exists: false });
      continue;
    }
    const markers = await scanFileMarkers(source, BRIDGE_MARKERS);
    const markerReady = BRIDGE_MARKERS.every(marker => markers?.[marker] === true);
    checked.push({
      source,
      exists: true,
      sizeBytes: info.sizeBytes,
      modifiedAtUtc: info.modifiedAtUtc,
      markerReady
    });
    if (!markerReady) continue;
    if (dryRun) {
      const destinationInfo = await statInfo(destination);
      const destinationMarkers = destinationInfo.exists ? await scanFileMarkers(destination, BRIDGE_MARKERS) : {};
      const destinationWritable = await probeBridgeSyncDestinationWritable(destination, destinationInfo);
      if (destinationWritable.writable === false) {
        return {
          ok: false,
          dryRun: true,
          reason: destinationWritable.reason,
          wouldCopy: true,
          source,
          destination,
          destinationBefore: destinationInfo,
          destinationMarkers,
          destinationWritable,
          sourceMarkers: markers,
          checked
        };
      }
      return {
        ok: true,
        dryRun: true,
        wouldCopy: true,
        source,
        destination,
        destinationBefore: destinationInfo,
        destinationMarkers,
        destinationWritable,
        sourceMarkers: markers,
        checked
      };
    }
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      const copied = await statInfo(destination);
      const copiedMarkers = await scanFileMarkers(destination, BRIDGE_MARKERS);
      return {
        ok: BRIDGE_MARKERS.every(marker => copiedMarkers?.[marker] === true),
        dryRun: false,
        source,
        destination,
        copied,
        markers: copiedMarkers,
        checked
      };
    } catch (error) {
      const copyError = classifyBridgeCopyError(error);
      return {
        ok: false,
        dryRun: false,
        reason: copyError.reason,
        source,
        destination,
        error: copyError.message,
        errorCode: copyError.code,
        errorCategory: copyError.category,
        nextAction: copyError.nextAction,
        checked
      };
    }
  }
  return {
    ok: false,
    dryRun,
    reason: "no_updated_bridge_dll_candidate",
    destination,
    checked
  };
}

function isRetryableBridgeSyncFailure(sync) {
  return sync?.reason === "copy_failed" || sync?.reason === "copy_target_locked_or_unavailable";
}

async function probeBridgeSyncDestinationWritable(destination, destinationInfo) {
  if (!destinationInfo?.exists) {
    return {
      ok: true,
      exists: false,
      writable: true,
      reason: "destination_missing",
      note: "Dry-run did not create the destination; confirmed sync will create the directory and copy the file."
    };
  }

  let handle = null;
  try {
    handle = await fs.open(destination, "r+");
    return {
      ok: true,
      exists: true,
      writable: true,
      reason: "destination_writable"
    };
  } catch (error) {
    const copyError = classifyBridgeCopyError(error);
    return {
      ok: false,
      exists: true,
      writable: false,
      reason: copyError.reason,
      error: copyError.message,
      errorCode: copyError.code,
      errorCategory: copyError.category,
      nextAction: copyError.nextAction
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

function classifyBridgeCopyError(error) {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || error || "");
  const combined = `${code} ${message}`;
  if (/EBUSY|EPERM|EACCES|UNKNOWN|being used|used by another process|cannot access.*because.*used|另一个程序|正在使用/i.test(combined)) {
    return {
      reason: "copy_target_locked_or_unavailable",
      category: "target_locked_or_unavailable",
      code: code || null,
      message,
      nextAction: "Close or restart the running game so Witch's Apocalyptic Journey_Data\\Mods\\CodexMcpBridge\\Scripts\\Entry.dll is released, then rerun witch_sync_bridge_artifacts with confirm:\"SYNC_BRIDGE_ARTIFACTS\"."
    };
  }
  return {
    reason: "copy_failed",
    category: "copy_failed",
    code: code || null,
    message,
    nextAction: "Inspect file permissions, source/destination paths, antivirus locks, and free disk space, then rerun witch_sync_bridge_artifacts."
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

  if ((!diagnostics.process?.running || startedOrRestarted) && launchIfNotRunning) {
    const sync = await syncUpdatedBridgeDllToDataRoot();
    steps.push({ name: "sync_bridge_dll_to_data_root", result: sync });
    if (!sync.ok) {
      return {
        ok: false,
        reason: "bridge_dll_sync_failed",
        recommendation: "Copy the updated bridge-mod\\Scripts\\Entry.dll into Witch's Apocalyptic Journey_Data\\Mods\\CodexMcpBridge\\Scripts\\Entry.dll after closing the game, then start the game again.",
        diagnostics,
        steps
      };
    }
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
    tasks.push(["ui", collectUiSnapshot({ includeHidden: !!args?.includeHidden })]);
  }
  if (args?.includeScene !== false) {
    tasks.push(["scene", collectSceneSnapshot({ includeInactive: false, onlyInteractive: args?.onlyInteractive !== false })]);
  }
  if (args?.includeBattle !== false) {
    tasks.push(["battle", collectBattleSnapshot(args || {})]);
  }
  if (args?.includeLegalActions !== false) {
    tasks.push(["legalActions", collectLegalActions({})]);
  }

  const results = await Promise.all(tasks.map(([, promise]) => promise));
  tasks.forEach(([name], index) => {
    snapshot[name] = results[index];
    if (!results[index].ok) snapshot.ok = false;
  });

  return snapshot;
}

async function collectBattleSnapshot(args) {
  const direct = await safeCallBridge("battle.snapshot", {
    includeInactive: !!args?.includeInactive,
    maxCards: limit(args?.maxCards, 40),
    maxTargets: limit(args?.maxTargets, 40)
  });
  if (direct?.ok === true) {
    const snapshot = direct?.data && typeof direct.data === "object" ? direct.data : direct;
    return {
      ...snapshot,
      ok: snapshot?.ok !== false,
      source: snapshot?.source || "battle.snapshot",
      bridgeSnapshot: direct?.data ? { ok: true, command: direct.command } : undefined
    };
  }

  const fallback = await collectBattleSnapshotFromRuntime(args || {});
  return {
    ...fallback,
    bridgeSnapshot: direct?.ok === false ? direct : undefined
  };
}

async function collectUiSnapshot(args) {
  const params = {
    scope: args?.scope || "",
    includeHidden: !!args?.includeHidden
  };
  const direct = await safeCallBridge("ui.snapshot", params);
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "ui.snapshot")) {
    return normalizeUiSnapshotVisibility(direct, params);
  }

  const fallback = await invokeAutomationStaticFallback("ui.snapshot", "Witch.UI.Automation.RuntimeUiAutomationService", "CaptureSnapshot", [params], direct);
  return normalizeUiSnapshotVisibility(fallback, params);
}

function normalizeUiSnapshotVisibility(result, params) {
  if (params?.includeHidden === true || result?.ok === false) return result;
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  if (!data || typeof data !== "object") return result;
  const windows = Array.isArray(data.Windows) ? data.Windows : null;
  const nodes = Array.isArray(data.Nodes) ? data.Nodes : null;
  if (!windows && !nodes) return result;
  const visibleWindows = windows
    ? windows.filter(item => fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false)
    : undefined;
  const visibleNodes = nodes
    ? nodes.filter(item => fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false)
    : undefined;
  const filteredData = {
    ...data,
    ...(visibleWindows ? { Windows: visibleWindows, HiddenWindowsFiltered: windows.length - visibleWindows.length } : {}),
    ...(visibleNodes ? { Nodes: visibleNodes, HiddenNodesFiltered: nodes.length - visibleNodes.length } : {})
  };
  if (result?.data && typeof result.data === "object") {
    return { ...result, data: filteredData, filteredHidden: true };
  }
  return { ...filteredData, filteredHidden: true };
}

async function interactUi(args) {
  const direct = await safeCallBridge("ui.interact", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "ui.interact")) {
    return compactUiInteractResult(direct, args || {});
  }

  const fallback = await invokeAutomationStaticFallback("ui.interact", "Witch.UI.Automation.RuntimeUiAutomationService", "InteractAsync", [args || {}], direct);
  return compactUiInteractResult(fallback, args || {});
}

function compactUiInteractResult(result, args) {
  if (args?.compact !== true && !Array.isArray(args?.fields)) return result;
  const fields = Array.isArray(args?.fields) && args.fields.length > 0
    ? new Set(args.fields)
    : new Set(["ok", "action", "selector", "matched", "postSummary", "error", "reason"]);
  const compact = {};
  for (const key of ["ok", "action", "selector", "matched", "error", "reason", "message", "source", "command"]) {
    if (fields.has(key) && result?.[key] !== undefined) compact[key] = result[key];
  }
  const postSnapshot = result?.postSnapshot || result?.PostSnapshot || result?.data?.postSnapshot || result?.data?.PostSnapshot;
  if ((fields.has("postSummary") || fields.has("activeWindows") || fields.has("clickables")) && postSnapshot) {
    const ui = postSnapshot.data || postSnapshot;
    compact.postSummary = {
      activeWindows: visibleUiWindows(ui).map(item => item.windowName).filter(Boolean),
      clickables: visibleUiNodes(ui, { includeHidden: false, onlyInteractive: true }).slice(0, 20).map(item => {
        const node = summarizeUiNode(item);
        return {
          label: node.label || node.text || null,
          nodeId: node.nodeId,
          windowName: node.windowName,
          transformPath: node.transformPath
        };
      })
    };
  }
  if (Object.keys(compact).length === 0) {
    compact.ok = result?.ok !== false;
    compact.rawKeys = result && typeof result === "object" ? Object.keys(result).slice(0, 20) : [];
  }
  return compact;
}

async function waitForUiOnce(args) {
  const direct = await safeCallBridge("ui.wait", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "ui.wait")) {
    return direct;
  }

  const snapshot = await collectUiSnapshot({ includeHidden: true });
  if (snapshot?.ok === false) {
    return {
      ok: false,
      reason: "ui_wait_snapshot_unavailable",
      direct,
      snapshot
    };
  }
  return invokeAutomationStaticFallback("ui.wait", "Witch.UI.Automation.RuntimeUiAutomationService", "EvaluateWaitCondition", [snapshot.data || snapshot, args || {}], direct);
}

function uiClickLabelArgs(args) {
  return {
    action: "click",
    selector: { label: args?.label, windowName: args?.windowName },
    requireClickable: args?.requireClickable !== false,
    includePostSnapshot: args?.includePostSnapshot !== false
  };
}

async function collectSceneSnapshot(args) {
  const params = {
    includeInactive: !!args?.includeInactive,
    onlyInteractive: args?.onlyInteractive !== false
  };
  const direct = await safeCallBridge("scene.snapshot", params);
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "scene.snapshot")) {
    return direct;
  }

  return invokeAutomationStaticFallback("scene.snapshot", "Witch.UI.Automation.RuntimeSceneAutomationService", "CaptureSnapshot", [params], direct);
}

async function interactScene(args) {
  const direct = await safeCallBridge("scene.interact", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "scene.interact")) {
    return direct;
  }

  return invokeAutomationStaticFallback("scene.interact", "Witch.UI.Automation.RuntimeSceneAutomationService", "InteractAsync", [args || {}], direct);
}

async function raycastScene(args) {
  const direct = await safeCallBridge("scene.raycast", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "scene.raycast")) {
    return direct;
  }

  return invokeAutomationStaticFallback("scene.raycast", "Witch.UI.Automation.RuntimeSceneAutomationService", "Raycast", [args || {}], direct);
}

async function playBattleCard(args) {
  const direct = await safeCallBridge("battle.play_card", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "battle.play_card")) {
    return direct;
  }

  return invokeAutomationStaticFallback("battle.play_card", "Witch.UI.Automation.RuntimeBattleAutomationService", "PlayCardAsync", [args || {}], direct);
}

async function collectLegalActions(args) {
  const direct = await safeCallBridge("game.legal_actions", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "game.legal_actions")) {
    return direct;
  }

  return invokeAutomationStaticFallback("game.legal_actions", "Witch.UI.Automation.RuntimeGameplayAutomationService", "GetLegalActions", [], direct);
}

async function performLegalAction(args) {
  const direct = await safeCallBridge("game.perform_action", args || {});
  if (direct?.ok !== false || !isUnknownBridgeCommand(direct, "game.perform_action")) {
    return direct;
  }

  return invokeAutomationStaticFallback("game.perform_action", "Witch.UI.Automation.RuntimeGameplayAutomationService", "PerformActionAsync", [args || {}], direct);
}

async function invokeAutomationStaticFallback(command, typeName, methodName, args, direct) {
  const fallbackArgs = {
    typeName,
    methodName,
    arguments: args
  };
  const fallback = await safeCallBridge("runtime.invoke_static", fallbackArgs);
  const data = fallback?.data?.result || fallback?.result?.result || fallback?.data;
  return {
    ...fallback,
    ok: fallback?.ok !== false,
    data,
    source: "runtime.invoke_static",
    fallbackFrom: command,
    fallbackReason: "bridge_command_unavailable",
    direct,
    runtimeCall: fallbackArgs,
    runtimeResult: fallback
  };
}

function isUnknownBridgeCommand(result, command) {
  const text = String(result?.error || result?.message || result?.reason || "");
  return result?.ok === false && text.toLowerCase().includes("unknown command") && text.includes(command);
}

async function collectBattleSnapshotFromRuntime(args) {
  const maxCards = limit(args?.maxCards, 40);
  const maxTargets = limit(args?.maxTargets, 40);
  const includeInactive = !!args?.includeInactive;
  const [cardObjects, statusTargets, enemyTargets] = await Promise.all([
    safeCallBridge("runtime.objects", { componentType: "CardItem", includeInactive, maxObjects: maxCards }),
    safeCallBridge("runtime.objects", { componentType: "StatusManager", includeInactive, maxObjects: maxTargets }),
    safeCallBridge("runtime.objects", { componentType: "EnemyItem", includeInactive, maxObjects: maxTargets })
  ]);

  const cards = runtimeObjectsFrom(cardObjects).slice(0, maxCards).map((item, index) => ({
    index,
    cardIndex: index,
    cardId: null,
    instanceId: firstComponentInstanceId(item, "CardItem"),
    objectInstanceId: item.instanceId,
    objectName: item.name,
    path: item.path,
    activeInHierarchy: item.activeInHierarchy,
    components: item.components,
    playCardCall: { tool: "witch_play_card", arguments: { cardIndex: index } }
  }));

  const seenTargets = new Set();
  const targets = [];
  for (const item of [...runtimeObjectsFrom(statusTargets), ...runtimeObjectsFrom(enemyTargets)]) {
    const key = item.instanceId || item.path || item.name;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    const index = targets.length;
    targets.push({
      index,
      targetIndex: index,
      targetName: item.name,
      instanceId: firstComponentInstanceId(item, "StatusManager") || firstComponentInstanceId(item, "EnemyItem"),
      objectInstanceId: item.instanceId,
      objectName: item.name,
      path: item.path,
      activeInHierarchy: item.activeInHierarchy,
      components: item.components
    });
    if (targets.length >= maxTargets) break;
  }
  const activeCardCount = cards.filter(item => item.activeInHierarchy !== false).length;
  const activeTargetCount = targets.filter(item => item.activeInHierarchy !== false).length;

  return {
    ok: cardObjects?.ok !== false && statusTargets?.ok !== false && enemyTargets?.ok !== false,
    capturedAtUtc: new Date().toISOString(),
    source: "runtime.objects",
    inBattle: activeCardCount > 0 || activeTargetCount > 0,
    cardCount: cards.length,
    targetCount: targets.length,
    activeCardCount,
    activeTargetCount,
    cards,
    targets,
    supportedActions: activeTargetCount > 0 ? ["play_card", "play_card_target"] : ["play_card"],
    runtimeQueries: { cards: cardObjects, statusTargets, enemyTargets }
  };
}

function runtimeObjectsFrom(result) {
  return Array.isArray(result?.data?.objects) ? result.data.objects : [];
}

function firstComponentInstanceId(object, componentName) {
  const components = Array.isArray(object?.components) ? object.components : [];
  const found = components.find(component => containsText(component?.name, componentName) || containsText(component?.type, componentName));
  return Number.isInteger(found?.instanceId) ? found.instanceId : null;
}

async function collectControlMap(args) {
  const snapshot = await collectGameSnapshot({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeUi: args?.includeUi !== false,
    includeScene: args?.includeScene !== false,
    includeBattle: args?.includeBattle !== false,
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
        const intent = classifyUiOperationIntent(node, action);
        operations.push({
          id: "ui:" + (node.nodeId || node.instanceId || index) + ":" + action,
          family: "ui",
          action,
          label: node.label || node.text || node.nodeId || node.transformPath || String(index),
          intent,
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

  if (args?.includeBattle !== false) {
    const battle = snapshot.battle?.data || snapshot.battle;
    const cards = Array.isArray(battle?.cards) ? battle.cards : [];
    const targets = Array.isArray(battle?.targets) ? battle.targets : [];
    cards.slice(0, limit(args?.maxCards, 200)).forEach((card, cardIndex) => {
      const baseArgs = compactPlayCardArgs(card, cardIndex);
      operations.push({
        id: "battle:card:" + (card.instanceId || card.cardId || cardIndex),
        family: "battle",
        action: "play_card",
        label: card.cardId || card.objectName || card.path || String(cardIndex),
        noMouse: true,
        ready: true,
        target: card,
        call: { tool: "witch_play_card", arguments: baseArgs }
      });
      targets.slice(0, limit(args?.maxTargets, 50)).forEach((target, targetIndex) => {
        operations.push({
          id: "battle:card:" + (card.instanceId || card.cardId || cardIndex) + ":target:" + (target.instanceId || target.targetName || targetIndex),
          family: "battle",
          action: "play_card_target",
          label: (card.cardId || card.objectName || String(cardIndex)) + " -> " + (target.targetName || target.objectName || String(targetIndex)),
          noMouse: true,
          ready: true,
          target: { card, target },
          call: { tool: "witch_play_card", arguments: { ...baseArgs, ...compactPlayTargetArgs(target, targetIndex) } }
        });
      });
    });
  }

  if (args?.includeRuntimeActions !== false) {
    const runtimeActionOperations = await collectRuntimeActionOperations(args || {});
    operations.push(...runtimeActionOperations.operations);
    if (args?.includeUnsupported !== false) {
      unmapped.push(...runtimeActionOperations.unmapped);
    }
  }

  const byFamily = {};
  for (const operation of operations) {
    byFamily[operation.family] = (byFamily[operation.family] || 0) + 1;
  }
  const rankedOperations = rankControlOperations(operations);

  return {
    ok: true,
    capturedAtUtc: snapshot.capturedAtUtc,
    noMouseDefault: DEFAULT_NO_MOUSE,
    operationCount: operations.length,
    readyOperationCount: operations.filter(item => item.ready).length,
    unmappedCount: unmapped.length,
    byFamily,
    operations: rankedOperations,
    recommendedOperations: rankedOperations.filter(item => item.ready !== false).slice(0, 12),
    unmapped,
    snapshotSummary: {
      phase: snapshot.legalActions?.data?.Phase || snapshot.legalActions?.data?.phase || null,
      uiNodeCount: arrayValue(snapshot.ui?.data || snapshot.ui, "Nodes").length,
      sceneObjectCount: arrayValue(snapshot.scene?.data || snapshot.scene, "Objects").length,
      battleCardCount: Number((snapshot.battle?.data || snapshot.battle)?.cardCount || 0),
      battleTargetCount: Number((snapshot.battle?.data || snapshot.battle)?.targetCount || 0),
      runtimeActionCount: byFamily.runtime_action || 0
    }
  };
}

async function collectEventRouteTrace(args) {
  const includeHidden = !!args?.includeHidden;
  const onlyInteractive = args?.onlyInteractive !== false;
  const maxUiNodes = limit(args?.maxUiNodes, 80);
  const maxActions = limit(args?.maxActions, 80);
  const maxRuntimeObjects = limit(args?.maxRuntimeObjects, 40);
  const maxMembersPerComponent = limit(args?.maxMembersPerComponent, 60);
  const snapshot = await collectGameSnapshot({
    includeHidden,
    onlyInteractive,
    includeUi: true,
    includeScene: false,
    includeBattle: false,
    includeLegalActions: true
  });

  if (!snapshot.ok) {
    return {
      ok: false,
      capturedAtUtc: snapshot.capturedAtUtc,
      reason: "state_unavailable",
      error: "Unable to trace event route because the bridge or state snapshots are unavailable.",
      snapshot
    };
  }

  const uiData = snapshot.ui?.data || snapshot.ui || {};
  const activeWindows = arrayValue(uiData, "Windows")
    .filter(window => fieldValue(window, "Visible") !== false && fieldValue(window, "ActiveInHierarchy") !== false)
    .map(window => ({
      windowName: fieldValue(window, "WindowName"),
      nodeId: fieldValue(window, "NodeId"),
      transformPath: fieldValue(window, "TransformPath")
    }))
    .filter(window => window.windowName || window.nodeId || window.transformPath);
  const uiNodes = arrayValue(uiData, "Nodes")
    .map(summarizeUiNode)
    .filter(node => isEventRouteUiNode(node, onlyInteractive))
    .slice(0, maxUiNodes);
  const legalActions = legalActionsFrom(snapshot.legalActions)
    .slice(0, maxActions)
    .map(summarizeAction);
  const runtime = await collectEventRouteRuntime({
    includeInactive: !!args?.includeInactive,
    includeComponentDetails: args?.includeComponentDetails !== false,
    maxRuntimeObjects,
    maxMembersPerComponent
  });
  const hookLogSummary = args?.includeHookLog === false
    ? null
    : await collectHookLogSummary({ tailLines: limit(args?.hookLogTailLines, 300) });

  const candidateSources = [];
  activeWindows.forEach((item, index) => candidateSources.push({ source: "ui.window", index, value: item }));
  uiNodes.forEach((item, index) => candidateSources.push({ source: "ui.node", index, value: item }));
  legalActions.forEach((item, index) => candidateSources.push({ source: "legal_action", index, value: item }));
  runtime.objects.forEach((item, index) => candidateSources.push({ source: "runtime.object", index, value: item }));
  runtime.fields.forEach((item, index) => candidateSources.push({ source: "runtime.field", index, value: item }));

  const candidates = dedupeRouteCandidates(candidateSources.flatMap(extractRouteCandidatesFromSource));
  const eventCandidates = candidates.filter(candidate => candidate.kind === "event_id").slice(0, 80);
  const mapCandidates = candidates.filter(candidate => candidate.kind === "map_node" || candidate.kind === "map_id").slice(0, 80);
  const route = buildEventRouteSteps({ activeWindows, uiNodes, legalActions, runtime, eventCandidates, mapCandidates });
  const confidence = eventRouteConfidence({ activeWindows, uiNodes, legalActions, runtime, eventCandidates, mapCandidates });

  return {
    ok: true,
    capturedAtUtc: new Date().toISOString(),
    confidence,
    activeWindows,
    route,
    eventCandidates,
    mapCandidates,
    legalActions,
    uiNodes,
    runtimeManagers: runtime.managers,
    runtimeObjects: runtime.objects,
    componentFields: runtime.fields,
    hookLogSummary,
    notes: [
      "This is a read-only correlation trace. Candidate ids are inferred from visible UI, legal actions, runtime objects, and readable component fields.",
      "Use higher-confidence candidates and route steps to debug event/map wiring before executing state-changing operations."
    ],
    snapshotSources: {
      ui: snapshot.ui?.ok !== false,
      legalActions: snapshot.legalActions?.ok !== false,
      runtime: runtime.ok
    }
  };
}

async function collectEventRouteRuntime(args) {
  const componentTypes = ["MapManager", "NormalMapManager", "MapItem", "EventUI", "EventManager"];
  const results = await Promise.all(componentTypes.map(componentType =>
    safeCallBridge("runtime.objects", {
      componentType,
      includeInactive: !!args?.includeInactive,
      maxObjects: args?.maxRuntimeObjects
    })
  ));
  const objects = [];
  const fields = [];

  for (let typeIndex = 0; typeIndex < componentTypes.length; typeIndex++) {
    const componentType = componentTypes[typeIndex];
    const result = results[typeIndex];
    const items = runtimeObjectsFrom(result).slice(0, args?.maxRuntimeObjects || 40);
    for (const item of items) {
      const object = summarizeRuntimeRouteObject(item, componentType, result);
      objects.push(object);
      if (args?.includeComponentDetails !== false && Number.isInteger(object.instanceId)) {
        const detail = await safeCallBridge("runtime.object_detail", {
          instanceId: object.instanceId,
          componentType,
          maxMembersPerComponent: args?.maxMembersPerComponent || 60
        });
        fields.push(...extractRouteFieldsFromRuntimeDetail(detail, object, componentType));
      }
    }
  }

  return {
    ok: results.some(result => result?.ok === true),
    managers: objects.filter(object => containsText(object.componentType, "Manager") || containsText(object.name, "Manager")),
    objects,
    fields,
    queries: componentTypes.map((componentType, index) => ({
      componentType,
      ok: results[index]?.ok === true,
      count: runtimeObjectsFrom(results[index]).length,
      error: results[index]?.error || null
    }))
  };
}

function summarizeRuntimeRouteObject(item, componentType, result) {
  return {
    sourceComponentType: componentType,
    name: item?.name || item?.Name || null,
    instanceId: item?.instanceId ?? item?.InstanceId ?? null,
    path: item?.path || item?.Path || item?.transformPath || item?.TransformPath || null,
    scene: item?.scene || item?.Scene || null,
    activeInHierarchy: item?.activeInHierarchy ?? item?.ActiveInHierarchy ?? null,
    componentType,
    components: Array.isArray(item?.components) ? item.components.map(component => ({
      type: component?.type || component?.Type || null,
      name: component?.name || component?.Name || null,
      enabled: component?.enabled ?? component?.Enabled ?? null
    })) : [],
    queryOk: result?.ok === true
  };
}

function extractRouteFieldsFromRuntimeDetail(detail, object, componentType) {
  const fields = [];
  const data = detail?.data || detail;
  const components = Array.isArray(data?.components) ? data.components : [];
  for (const component of components) {
    const members = Array.isArray(component?.members) ? component.members : [];
    for (const member of members) {
      const name = member?.name || member?.Name || "";
      if (!isRouteFieldName(name)) continue;
      fields.push({
        objectName: object.name,
        objectInstanceId: object.instanceId,
        objectPath: object.path,
        componentType: component?.type || component?.Type || componentType,
        componentName: component?.name || component?.Name || componentType,
        name,
        kind: member?.kind || member?.Kind || null,
        type: member?.type || member?.Type || null,
        value: compactRouteFieldValue(member?.value ?? member?.Value ?? member?.currentValue ?? member?.CurrentValue),
        readable: member?.readable ?? member?.Readable ?? null,
        writable: member?.writable ?? member?.Writable ?? null
      });
    }
  }
  return fields.slice(0, 200);
}

function compactRouteFieldValue(value) {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map(compactRouteFieldValue);
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).slice(0, 20)) {
      const item = value[key];
      if (item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        result[key] = item;
      }
    }
    return result;
  }
  return String(value);
}

function isEventRouteUiNode(node, onlyInteractive) {
  const identityHaystack = [
    node.nodeId,
    node.label,
    node.text,
    node.windowName,
    node.transformPath
  ].filter(Boolean).join(" ");
  const componentHaystack = (Array.isArray(node.componentTypes) ? node.componentTypes : []).filter(Boolean).join(" ");
  if (!identityHaystack && !componentHaystack) return false;
  const routeRelated = ["event", "map", "select", "selector", "option"]
    .some(word => containsText(identityHaystack, word)) ||
    ["EventUI", "MapSelectUI", "MapItem", "EventOption"]
      .some(word => containsText(componentHaystack, word));
  if (!routeRelated) return false;
  if (!onlyInteractive) return true;
  return node.interactable !== false || node.clickable === true || (Array.isArray(node.supportedActions) && node.supportedActions.length > 0);
}

function isRouteFieldName(name) {
  const text = normalizeText(name);
  return ["id", "event", "map", "node", "data", "note", "command", "archive", "route", "select", "current"]
    .some(token => text.includes(token));
}

function extractRouteCandidatesFromSource(source) {
  const candidates = [];
  collectPrimitiveRouteValues(source.value, "", (pathName, value) => {
    const text = String(value || "");
    const key = pathName.split(".").pop() || "";
    const sourceWeight = routeSourceWeight(source.source);
    const fieldWeight = routeFieldWeight(key);
    const explicitKind = routeKindFromField(key, text);
    if (explicitKind) {
      candidates.push({
        kind: explicitKind,
        value: text,
        source: source.source,
        sourceIndex: source.index,
        path: pathName,
        confidence: Math.min(1, sourceWeight + fieldWeight + 0.2)
      });
    }
    for (const match of routeIdMatches(text)) {
      candidates.push({
        kind: match.kind,
        value: match.value,
        source: source.source,
        sourceIndex: source.index,
        path: pathName,
        confidence: Math.min(1, sourceWeight + fieldWeight + match.weight)
      });
    }
  });
  return candidates;
}

function collectPrimitiveRouteValues(value, pathName, visitor) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    visitor(pathName || "value", value);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((item, index) => collectPrimitiveRouteValues(item, pathName + "[" + index + "]", visitor));
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value).slice(0, 80)) {
      collectPrimitiveRouteValues(value[key], pathName ? pathName + "." + key : key, visitor);
    }
  }
}

function routeIdMatches(text) {
  const result = [];
  const seen = new Set();
  const patterns = [
    { kind: "event_id", regex: /\b(?:event|evt)[_-]?\d+\b/ig, weight: 0.3 },
    { kind: "event_id", regex: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){2,}\b/g, weight: 0.22 },
    { kind: "map_node", regex: /\b(?:node|map)[_-]?\d+\b/ig, weight: 0.22 },
    { kind: "map_id", regex: /\bmap[_-][A-Za-z0-9_]+\b/ig, weight: 0.18 }
  ];
  for (const pattern of patterns) {
    for (const match of String(text || "").matchAll(pattern.regex)) {
      const value = match[0];
      const key = pattern.kind + ":" + value.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ kind: pattern.kind, value, weight: pattern.weight });
    }
  }
  return result;
}

function routeKindFromField(fieldName, value) {
  const field = normalizeText(fieldName);
  const text = String(value || "");
  if (!text || text.length > 240) return null;
  if (field.includes("event") && field.includes("id")) return "event_id";
  if (field === "id" && routeIdMatches(text).some(item => item.kind === "event_id")) return "event_id";
  if (field.includes("node") && field.includes("id")) {
    if (isUiNodeIdentifierValue(text)) return "ui_node_id";
    if (field.includes("map") || routeIdMatches(text).some(item => item.kind === "map_node")) return "map_node";
  }
  if (field.includes("map") && field.includes("id")) return "map_id";
  return null;
}

function isUiNodeIdentifierValue(value) {
  const text = String(value || "");
  return text.includes("|") || text.includes("/Canvas/") || text.startsWith("Canvas/");
}

function routeSourceWeight(source) {
  if (source === "runtime.field") return 0.45;
  if (source === "runtime.object") return 0.32;
  if (source === "legal_action") return 0.3;
  if (source === "ui.node") return 0.22;
  if (source === "ui.window") return 0.18;
  return 0.1;
}

function routeFieldWeight(field) {
  const text = normalizeText(field);
  if (text.includes("event") && text.includes("id")) return 0.3;
  if (text.includes("node") && text.includes("data")) return 0.28;
  if (text.includes("node") && text.includes("id")) return 0.24;
  if (text.includes("map") && text.includes("id")) return 0.24;
  if (text === "id" || text.endsWith(".id")) return 0.16;
  return 0;
}

function dedupeRouteCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const key = candidate.kind + ":" + String(candidate.value).toLocaleLowerCase();
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence || String(a.value).localeCompare(String(b.value)));
}

function buildEventRouteSteps({ activeWindows, uiNodes, legalActions, runtime, eventCandidates, mapCandidates }) {
  const steps = [];
  if (activeWindows.length > 0) {
    steps.push({
      layer: "ui",
      name: "active_windows",
      summary: activeWindows.map(window => window.windowName || window.nodeId).filter(Boolean).join(" -> "),
      evidence: activeWindows.slice(0, 10)
    });
  }
  if (uiNodes.length > 0) {
    steps.push({
      layer: "ui",
      name: "event_or_map_ui_nodes",
      summary: uiNodes.slice(0, 5).map(node => node.label || node.text || node.transformPath || node.nodeId).filter(Boolean).join(" | "),
      evidence: uiNodes.slice(0, 10)
    });
  }
  if (legalActions.length > 0) {
    steps.push({
      layer: "gameplay_legal",
      name: "legal_actions",
      summary: legalActions.slice(0, 5).map(action => action.id || action.label || action.kind).filter(Boolean).join(" | "),
      evidence: legalActions.slice(0, 10)
    });
  }
  if (runtime.managers.length > 0) {
    steps.push({
      layer: "runtime",
      name: "map_event_managers",
      summary: runtime.managers.slice(0, 5).map(item => item.componentType + ":" + (item.name || item.instanceId)).join(" | "),
      evidence: runtime.managers.slice(0, 10)
    });
  }
  if (mapCandidates.length > 0) {
    steps.push({
      layer: "runtime_or_ui",
      name: "map_candidates",
      summary: mapCandidates.slice(0, 5).map(item => item.value).join(" | "),
      evidence: mapCandidates.slice(0, 10)
    });
  }
  if (eventCandidates.length > 0) {
    steps.push({
      layer: "runtime_or_ui",
      name: "event_candidates",
      summary: eventCandidates.slice(0, 5).map(item => item.value).join(" | "),
      evidence: eventCandidates.slice(0, 10)
    });
  }
  return steps;
}

function eventRouteConfidence({ activeWindows, uiNodes, legalActions, runtime, eventCandidates, mapCandidates }) {
  let score = 0;
  if (activeWindows.some(window => containsText(window.windowName, "EventUI") || containsText(window.windowName, "Map"))) score += 0.15;
  if (uiNodes.length > 0) score += 0.15;
  if (legalActions.length > 0) score += 0.15;
  if (runtime.managers.length > 0) score += 0.2;
  if (mapCandidates.length > 0) score += 0.15;
  if (eventCandidates.length > 0) score += 0.2;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

async function assertRoute(args) {
  const trace = await collectEventRouteTrace({
    ...args,
    includeComponentDetails: args?.includeComponentDetails !== false,
    includeHookLog: args?.includeHookLog !== false
  });
  const textAssertion = await evaluateUiTextAssertion({
    ...args,
    expectedTexts: asStringArray(args?.expectedTexts, args?.expectedText),
    requireAll: true
  });
  const forbiddenAssertion = await evaluateForbiddenTextAssertion({
    ...args,
    forbiddenTexts: asStringArray(args?.forbiddenTexts, args?.forbiddenText)
  });
  const eventAssertion = evaluateRouteCandidateAssertion({
    candidates: trace.eventCandidates || [],
    expected: asStringArray(args?.expectedEventIds, args?.expectedEventId),
    requireAll: true,
    caseSensitive: !!args?.caseSensitive,
    exact: args?.exact !== false
  });
  const mapAssertion = evaluateRouteCandidateAssertion({
    candidates: trace.mapCandidates || [],
    expected: asStringArray(args?.expectedMapNodes, args?.expectedMapNode),
    requireAll: true,
    caseSensitive: !!args?.caseSensitive,
    exact: args?.exact !== false
  });
  const minConfidence = Number(args?.minConfidence || 0);
  const confidenceAssertion = {
    ok: !Number.isFinite(minConfidence) || minConfidence <= 0 || Number(trace.confidence || 0) >= minConfidence,
    actual: Number(trace.confidence || 0),
    expectedAtLeast: Number.isFinite(minConfidence) ? minConfidence : 0
  };
  const checks = [
    { name: "route_available", ok: trace.ok === true },
    { name: "event_ids", ...eventAssertion },
    { name: "map_nodes", ...mapAssertion },
    { name: "expected_text", ...textAssertion },
    { name: "forbidden_text", ...forbiddenAssertion },
    { name: "confidence", ...confidenceAssertion }
  ];
  const activeChecks = checks.filter(check => check.ok !== null);
  const pass = activeChecks.length > 0 && activeChecks.every(check => check.ok === true);
  return {
    ok: pass,
    assertion: "route",
    capturedAtUtc: new Date().toISOString(),
    checks,
    missing: activeChecks.flatMap(check => check.missing || []),
    violations: activeChecks.flatMap(check => check.violations || []),
    trace
  };
}

async function assertUiText(args) {
  const assertion = await evaluateUiTextAssertion({
    ...args,
    expectedTexts: asStringArray(args?.expectedTexts, args?.expectedText),
    requireAll: args?.requireAll !== false
  });
  return {
    ok: assertion.ok === true,
    assertion: "ui_text",
    capturedAtUtc: new Date().toISOString(),
    ...assertion
  };
}

async function assertEventId(args) {
  const trace = await collectEventRouteTrace({
    ...args,
    includeHookLog: args?.includeHookLog !== false
  });
  const assertion = evaluateRouteCandidateAssertion({
    candidates: trace.eventCandidates || [],
    expected: asStringArray(args?.expectedEventIds, args?.expectedEventId),
    requireAll: args?.requireAll !== false,
    caseSensitive: !!args?.caseSensitive,
    exact: args?.exact !== false
  });
  return {
    ok: trace.ok === true && assertion.ok === true,
    assertion: "event_id",
    capturedAtUtc: new Date().toISOString(),
    ...assertion,
    trace
  };
}

async function assertForbiddenText(args) {
  const assertion = await evaluateForbiddenTextAssertion({
    ...args,
    forbiddenTexts: asStringArray(args?.forbiddenTexts, args?.forbiddenText)
  });
  return {
    ok: assertion.ok === true,
    assertion: "forbidden_text",
    capturedAtUtc: new Date().toISOString(),
    ...assertion
  };
}

async function chooseEventOption(args) {
  const options = await collectEventOptionCandidates({ includeHidden: false, onlyInteractive: true });
  const selected = selectOptionCandidate(options, {
    index: args?.index,
    text: args?.text ?? args?.label,
    nodeId: args?.nodeId,
    contains: args?.contains !== false
  });
  if (!selected) {
    return {
      ok: false,
      dryRun: args?.dryRun !== false,
      reason: "event_option_not_found",
      selector: { index: args?.index ?? null, text: args?.text ?? args?.label ?? null, nodeId: args?.nodeId ?? null },
      availableOptions: options
    };
  }
  return executeUiCandidate("event_option", selected, args || {});
}

async function selectMapNode(args) {
  const options = await collectMapNodeCandidates({ includeHidden: false, onlyInteractive: true });
  const selected = selectOptionCandidate(options, {
    index: args?.index,
    text: args?.text ?? args?.label ?? args?.id,
    nodeId: args?.id,
    contains: args?.contains !== false
  });
  if (!selected) {
    return {
      ok: false,
      dryRun: args?.dryRun !== false,
      reason: "map_node_not_found",
      selector: { index: args?.index ?? null, id: args?.id ?? null, label: args?.label ?? null, text: args?.text ?? null },
      availableNodes: options
    };
  }
  return executeUiCandidate("map_node", selected, args || {});
}

async function executeUiCandidate(kind, selected, args) {
  const dryRun = args?.dryRun !== false;
  const call = {
    tool: "witch_ui_interact",
    arguments: {
      action: "click",
      selector: selected.selector,
      includePostSnapshot: false,
      compact: true
    }
  };
  const response = {
    ok: true,
    kind,
    dryRun,
    selected,
    plannedCall: call
  };
  if (dryRun) {
    response.result = { ok: true, skipped: true, plannedTool: call.tool, arguments: call.arguments };
    return response;
  }
  const before = await collectOperationStateFingerprint({ includeHidden: false, onlyInteractive: true });
  response.result = await interactUi(call.arguments);
  const timeoutMs = Math.max(0, Math.min(10000, Number(args?.timeoutMs ?? 3000)));
  response.wait = await waitForStateChange(before, { stateChanged: true, timeoutMs, pollMs: 150 });
  response.ok = response.result?.ok !== false && response.wait?.changed === true;
  if (!response.ok && response.result?.ok !== false) {
    response.reason = "ui_choice_unverified_no_state_change";
  }
  if (args?.includePostSummary !== false) {
    response.postSummary = await collectStoryMapSnapshot({ includeHidden: false, onlyInteractive: false, includeHookLog: false });
  }
  return response;
}

async function collectStoryMapSnapshot(args) {
  const trace = await collectEventRouteTrace({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive === true,
    includeComponentDetails: true,
    includeHookLog: !!args?.includeHookLog,
    maxUiNodes: 80,
    maxActions: 80,
    maxRuntimeObjects: 30,
    maxMembersPerComponent: 50
  });
  const snapshot = await collectGameSnapshot({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive === true,
    includeUi: true,
    includeScene: false,
    includeBattle: false,
    includeLegalActions: true
  });
  const uiData = snapshot.ui?.data || snapshot.ui || {};
  const activeWindows = visibleUiWindows(uiData);
  const visibleNodes = visibleUiNodes(uiData, { includeHidden: !!args?.includeHidden, onlyInteractive: false });
  const options = collectOptionCandidatesFromNodes(visibleNodes, { eventOnly: false, mapOnly: false })
    .slice(0, limit(args?.maxOptions, 20));
  const allTexts = visibleNodes
    .flatMap(node => [fieldValue(node, "Label"), fieldValue(node, "Text")])
    .filter(Boolean)
    .map(String);
  const fields = routeFieldsByName(trace.componentFields || []);
  const result = {
    ok: trace.ok === true || snapshot.ok === true,
    capturedAtUtc: new Date().toISOString(),
    currentWindow: activeWindows[0]?.windowName || null,
    activeWindows: activeWindows.map(item => item.windowName).filter(Boolean),
    mapTitle: firstPatternText(allTexts, /(map|地图|区域|地点|旅途|路线)/i),
    eventTitle: firstPatternText(allTexts, /(event|事件|选择|遭遇|剧情|回声|档案|幕)/i),
    eventId: firstValue([fields.eventId, fields.currentEventId, trace.eventCandidates?.[0]?.value]),
    mapId: firstValue([fields.mapId, fields.currentMapId, trace.mapCandidates?.find(item => item.kind === "map_id")?.value]),
    currentNodeId: firstValue([fields.currentNodeId, fields.currentMapNodeId, fields.nodeId, trace.mapCandidates?.find(item => item.kind === "map_node")?.value]),
    currentRoomType: firstValue([fields.currentRoomType, fields.roomType, fields.type]),
    availableOptions: options,
    isTransitioning: inferTransitioning(activeWindows, allTexts, trace),
    routeConfidence: trace.confidence,
    route: trace.route,
    snapshotSources: {
      ui: snapshot.ui?.ok !== false,
      legalActions: snapshot.legalActions?.ok !== false,
      routeTrace: trace.ok === true
    }
  };
  result.titles = {
    all: [...new Set(allTexts)].slice(0, 30)
  };
  return result;
}

async function logTail(args) {
  const info = await statInfo(PLAYER_LOG_PATH);
  if (!info.exists) {
    return {
      ok: false,
      path: PLAYER_LOG_PATH,
      exists: false,
      reason: "player_log_not_found",
      error: info.error || null
    };
  }
  try {
    const text = await fs.readFile(PLAYER_LOG_PATH, "utf8");
    const allLines = text.split(/\r?\n/).filter(Boolean);
    const maxLines = Math.max(1, Math.min(2000, Number(args?.lines ?? 120)));
    let lines = allLines.slice(-Math.max(maxLines, 1));
    const pattern = String(args?.pattern || "");
    if (pattern) {
      const flags = args?.caseSensitive ? "" : "i";
      let regex = null;
      try {
        regex = new RegExp(pattern, flags);
      } catch {
        regex = null;
      }
      lines = allLines.filter(line => regex ? regex.test(line) : textMatches(line, pattern, { caseSensitive: !!args?.caseSensitive })).slice(-maxLines);
    }
    return {
      ok: true,
      path: PLAYER_LOG_PATH,
      exists: true,
      sizeBytes: info.sizeBytes,
      modifiedAtUtc: info.modifiedAtUtc,
      pattern: pattern || null,
      totalLines: allLines.length,
      returnedLines: lines.length,
      lines
    };
  } catch (error) {
    return { ok: false, path: PLAYER_LOG_PATH, exists: true, reason: "player_log_read_failed", error: String(error?.message || error) };
  }
}

async function captureScreenshotSummary(args) {
  const capture = await captureAndWait({
    path: args?.path,
    directory: args?.directory,
    timeoutMs: args?.timeoutMs ?? 5000,
    pollMs: args?.pollMs ?? 100
  });
  const result = {
    ...capture,
    screenshotPath: capture.fullPath || capture.path || capture.data?.path || null
  };
  if (args?.includeUiText !== false) {
    const snapshot = await collectStoryMapSnapshot({
      includeHidden: false,
      onlyInteractive: false,
      includeHookLog: false,
      maxOptions: limit(args?.maxUiText, 40)
    });
    result.ui = {
      currentWindow: snapshot.currentWindow,
      activeWindows: snapshot.activeWindows,
      mapTitle: snapshot.mapTitle,
      eventTitle: snapshot.eventTitle,
      availableOptions: snapshot.availableOptions,
      titles: snapshot.titles?.all?.slice(0, limit(args?.maxUiText, 40)) || []
    };
  }
  return result;
}

async function collectEventOptionCandidates(args) {
  const snapshot = await collectUiSnapshot({ includeHidden: false });
  const nodes = visibleUiNodes(snapshot.data || snapshot, { includeHidden: false, onlyInteractive: true });
  return collectOptionCandidatesFromNodes(nodes, { eventOnly: true, mapOnly: false });
}

async function collectMapNodeCandidates(args) {
  const snapshot = await collectUiSnapshot({ includeHidden: false });
  const nodes = visibleUiNodes(snapshot.data || snapshot, { includeHidden: false, onlyInteractive: true });
  return collectOptionCandidatesFromNodes(nodes, { eventOnly: false, mapOnly: true });
}

function collectOptionCandidatesFromNodes(nodes, options) {
  const candidates = [];
  for (const item of nodes || []) {
    const node = summarizeUiNode(item);
    const text = [node.label, node.text, node.nodeId, node.windowName, node.transformPath, ...(node.componentTypes || [])].filter(Boolean).join(" ");
    const isEvent = /eventui|eventoption|choice|option|selector|event|事件|选项|选择/i.test(text);
    const isMap = /mapselectui|mapitem|map|node|地图|节点|路线/i.test(text);
    if (options?.eventOnly && !isEvent) continue;
    if (options?.mapOnly && !isMap) continue;
    if (node.clickable !== true && !(node.supportedActions || []).some(action => normalizeActionName(action) === "click" || normalizeActionName(action) === "submit")) continue;
    candidates.push({
      index: candidates.length,
      label: node.label || node.text || null,
      text: node.text || node.label || null,
      nodeId: node.nodeId,
      windowName: node.windowName,
      transformPath: node.transformPath,
      componentTypes: node.componentTypes || [],
      selector: compactUiSelector(node)
    });
  }
  return candidates;
}

function selectOptionCandidate(options, selector) {
  if (Number.isInteger(selector?.index)) return options[selector.index] || null;
  if (selector?.nodeId) {
    const expected = String(selector.nodeId);
    const byId = options.find(item => item.nodeId === expected || item.nodeId?.includes(expected));
    if (byId) return byId;
  }
  if (selector?.text) {
    return options.find(item => {
      const haystack = [item.label, item.text, item.nodeId, item.transformPath].filter(Boolean).join(" ");
      return textMatches(haystack, selector.text, { caseSensitive: false, exact: selector.contains === false });
    }) || null;
  }
  return options[0] || null;
}

function visibleUiWindows(ui) {
  return arrayValue(ui, "Windows")
    .filter(item => fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false)
    .map(item => ({
      windowName: fieldValue(item, "WindowName"),
      nodeId: fieldValue(item, "NodeId"),
      transformPath: fieldValue(item, "TransformPath")
    }));
}

function visibleUiNodes(ui, args) {
  return arrayValue(ui, "Nodes")
    .filter(item => args?.includeHidden || (fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false))
    .filter(item => args?.onlyInteractive !== true || fieldValue(item, "Interactable") !== false || fieldValue(item, "Clickable") === true || normalizedActions(item).length > 0);
}

function routeFieldsByName(fields) {
  const result = {};
  for (const field of fields || []) {
    const name = field?.name || "";
    const key = normalizeRouteFieldKey(name);
    if (!key || result[key] != null) continue;
    result[key] = compactRouteFieldValue(field.value);
  }
  return result;
}

function normalizeRouteFieldKey(name) {
  const text = String(name || "").replace(/[^A-Za-z0-9]+/g, "");
  if (!text) return "";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function firstValue(values) {
  for (const value of values || []) {
    if (value != null && String(value).trim() !== "") return value;
  }
  return null;
}

function firstUsefulText(values, pattern) {
  const unique = [...new Set((values || []).map(String).filter(value => value.trim() !== ""))];
  return unique.find(value => pattern.test(value)) || unique.find(value => value.length > 1 && value.length < 80) || null;
}

function firstPatternText(values, pattern) {
  const unique = [...new Set((values || []).map(String).filter(value => value.trim() !== ""))];
  return unique.find(value => pattern.test(value)) || null;
}

function inferTransitioning(activeWindows, texts, trace) {
  const haystack = [
    ...(activeWindows || []).map(item => item.windowName || ""),
    ...(texts || []),
    ...(trace.route || []).map(item => item.name || "")
  ].join(" ");
  return /(loading|transition|changing|切换|加载|读取|正在|请稍候)/i.test(haystack);
}

async function evaluateUiTextAssertion(args) {
  const expected = asStringArray(args?.expectedTexts, args?.expectedText);
  if (expected.length === 0) {
    return { ok: null, skipped: true, reason: "no_expected_text", expected, matches: [], missing: [] };
  }
  const context = await collectUiTextAssertionContext(args || {});
  if (!context.ok) {
    return { ok: false, expected, matches: [], missing: expected, context };
  }
  const result = evaluateTextPresence({
    expected,
    evidence: context.evidence,
    requireAll: args?.requireAll !== false,
    caseSensitive: !!args?.caseSensitive,
    exact: !!args?.exact
  });
  return { ...result, context: compactUiAssertionContext(context) };
}

async function evaluateForbiddenTextAssertion(args) {
  const forbidden = asStringArray(args?.forbiddenTexts, args?.forbiddenText);
  if (forbidden.length === 0) {
    return { ok: null, skipped: true, reason: "no_forbidden_text", forbidden, violations: [] };
  }
  const context = await collectUiTextAssertionContext(args || {});
  if (!context.ok) {
    return { ok: false, forbidden, violations: [], context };
  }
  const violations = [];
  for (const item of forbidden) {
    const matches = findTextMatches(context.evidence, item, args || {});
    if (matches.length > 0) {
      violations.push({ text: item, matches });
    }
  }
  return {
    ok: violations.length === 0,
    forbidden,
    violations,
    context: compactUiAssertionContext(context)
  };
}

async function collectUiTextAssertionContext(args) {
  const includeHidden = !!args?.includeHidden;
  const onlyInteractive = args?.onlyInteractive === true;
  const snapshot = await collectGameSnapshot({
    includeUi: true,
    includeScene: false,
    includeBattle: false,
    includeLegalActions: false,
    includeHidden,
    onlyInteractive
  });
  if (!snapshot.ok) {
    return {
      ok: false,
      reason: "snapshot_unavailable",
      snapshot
    };
  }
  const uiData = snapshot.ui?.data || snapshot.ui || {};
  const evidence = [];
  arrayValue(uiData, "Windows")
    .filter(window => includeHidden || (fieldValue(window, "Visible") !== false && fieldValue(window, "ActiveInHierarchy") !== false))
    .forEach((window, index) => {
      addTextEvidence(evidence, "ui.window", index, "windowName", fieldValue(window, "WindowName"), window);
    });
  arrayValue(uiData, "Nodes")
    .filter(node => includeHidden || (fieldValue(node, "Visible") !== false && fieldValue(node, "ActiveInHierarchy") !== false))
    .filter(node => !onlyInteractive || fieldValue(node, "Interactable") !== false || fieldValue(node, "Clickable") === true || normalizedActions(node).length > 0)
    .map(summarizeUiNode)
    .forEach((node, index) => {
      addTextEvidence(evidence, "ui.node", index, "label", node.label, node);
      addTextEvidence(evidence, "ui.node", index, "text", node.text, node);
      addTextEvidence(evidence, "ui.node", index, "windowName", node.windowName, node);
    });
  return {
    ok: true,
    capturedAtUtc: snapshot.capturedAtUtc,
    evidence,
    sample: evidence.slice(0, 20),
    snapshotSources: { ui: snapshot.ui?.ok !== false }
  };
}

function compactUiAssertionContext(context) {
  if (!context || context.ok === false) return context;
  return {
    ok: true,
    capturedAtUtc: context.capturedAtUtc,
    evidenceCount: Array.isArray(context.evidence) ? context.evidence.length : 0,
    sample: context.sample || [],
    snapshotSources: context.snapshotSources
  };
}

function addTextEvidence(evidence, source, index, field, value, owner) {
  if (value == null || String(value).trim() === "") return;
  evidence.push({
    value: String(value),
    source,
    sourceIndex: index,
    field,
    nodeId: fieldValue(owner, "NodeId") || owner?.nodeId || null,
    windowName: fieldValue(owner, "WindowName") || owner?.windowName || null,
    transformPath: fieldValue(owner, "TransformPath") || owner?.transformPath || null
  });
}

function evaluateRouteCandidateAssertion(args) {
  const expected = asStringArray(args?.expected);
  if (expected.length === 0) {
    return { ok: null, skipped: true, reason: "no_expected_candidates", expected, matches: [], missing: [] };
  }
  const evidence = (args?.candidates || []).map(candidate => ({
    value: candidate.value,
    source: candidate.source,
    sourceIndex: candidate.sourceIndex,
    field: candidate.path,
    confidence: candidate.confidence,
    candidate
  }));
  return evaluateTextPresence({
    expected,
    evidence,
    requireAll: args?.requireAll !== false,
    caseSensitive: !!args?.caseSensitive,
    exact: args?.exact !== false
  });
}

function evaluateTextPresence(args) {
  const matches = [];
  const missing = [];
  for (const item of args.expected || []) {
    const itemMatches = findTextMatches(args.evidence || [], item, args);
    if (itemMatches.length > 0) {
      matches.push({ text: item, matches: itemMatches });
    } else {
      missing.push(item);
    }
  }
  const ok = args.requireAll
    ? missing.length === 0
    : matches.length > 0;
  return {
    ok,
    requireAll: !!args.requireAll,
    expected: args.expected || [],
    matches,
    missing
  };
}

function findTextMatches(evidence, expected, options) {
  return (evidence || [])
    .filter(item => textMatches(item.value, expected, options || {}))
    .slice(0, 20);
}

function textMatches(value, expected, options) {
  const actualText = String(value || "");
  const expectedText = String(expected || "");
  const actual = options?.caseSensitive ? actualText : actualText.toLocaleLowerCase();
  const query = options?.caseSensitive ? expectedText : expectedText.toLocaleLowerCase();
  if (!query) return false;
  return options?.exact ? actual === query : actual.includes(query);
}

function asStringArray(value, singleValue) {
  const result = [];
  if (Array.isArray(value)) {
    value.forEach(item => {
      if (item != null && String(item).trim() !== "") result.push(String(item));
    });
  }
  if (singleValue != null && String(singleValue).trim() !== "") {
    result.push(String(singleValue));
  }
  return [...new Set(result)];
}

async function collectHookLogSummary(args) {
  const info = await statInfo(PLAYER_LOG_PATH);
  if (!info.exists) {
    return {
      ok: false,
      path: PLAYER_LOG_PATH,
      exists: false,
      reason: "player_log_not_found",
      error: info.error || null
    };
  }
  try {
    const text = await fs.readFile(PLAYER_LOG_PATH, "utf8");
    const allLines = text.split(/\r?\n/).filter(Boolean);
    const tailLines = Math.max(20, Math.min(2000, Number(args?.tailLines || 300)));
    const tail = allLines.slice(-tailLines);
    const relevant = tail.filter(line => /\b(CodexMcpBridge|hook|event|map|archive|EchoEnding|allow|allowed|block|blocked|forbid|forbidden)\b/i.test(line)).slice(-80);
    const routeMatches = dedupeRouteCandidates(relevant.flatMap((line, index) =>
      routeIdMatches(line).map(match => ({
        kind: match.kind,
        value: match.value,
        source: "player_log",
        sourceIndex: index,
        path: "line",
        confidence: Math.min(1, 0.35 + match.weight)
      }))
    ));
    return {
      ok: true,
      path: PLAYER_LOG_PATH,
      exists: true,
      sizeBytes: info.sizeBytes,
      modifiedAtUtc: info.modifiedAtUtc,
      inspectedTailLines: tailLines,
      matchedLineCount: relevant.length,
      recentLines: relevant,
      eventCandidates: routeMatches.filter(item => item.kind === "event_id").slice(0, 40),
      mapCandidates: routeMatches.filter(item => item.kind === "map_node" || item.kind === "map_id").slice(0, 40),
      blockedOrForbiddenLines: relevant.filter(line => /\b(block|blocked|forbid|forbidden|deny|denied)\b/i.test(line)).slice(-20),
      allowedLines: relevant.filter(line => /\b(allow|allowed)\b/i.test(line)).slice(-20)
    };
  } catch (error) {
    return {
      ok: false,
      path: PLAYER_LOG_PATH,
      exists: true,
      reason: "player_log_read_failed",
      error: String(error?.message || error)
    };
  }
}

async function collectRuntimeActionOperations(args) {
  const specs = runtimeActionSpecs();
  const maxPerComponent = limit(args?.maxRuntimeActions, 50);
  const operations = [];
  const unmapped = [];

  for (const spec of specs) {
    const result = await safeCallBridge("runtime.objects", {
      componentType: spec.componentType,
      includeInactive: !!args?.includeInactiveRuntimeActions,
      maxObjects: limit(args?.maxRuntimeObjects, 20)
    });
    if (result?.ok === false) {
      unmapped.push({ family: "runtime_action", reason: "runtime_objects_unavailable", componentType: spec.componentType, error: result.error || result.reason || result.message });
      continue;
    }
    const objects = runtimeObjectsFrom(result).filter(item => item?.activeInHierarchy !== false);
    for (const object of objects) {
      for (const method of spec.methods) {
        const id = "runtime:" + spec.componentType + ":" + (object.instanceId || object.path || object.name || "object") + ":" + method.name;
        operations.push({
          id,
          family: "runtime_action",
          action: method.action || method.name,
          label: method.label || (spec.componentType + "." + method.name),
          noMouse: true,
          ready: false,
          requiresArguments: ["dryRun_false_and_confirm_CALL_WITCH_COMPONENT_METHOD"],
          target: {
            componentType: spec.componentType,
            methodName: method.name,
            objectName: object.name,
            instanceId: object.instanceId,
            path: object.path,
            activeInHierarchy: object.activeInHierarchy,
            risk: method.risk || "state_changing"
          },
          call: {
            tool: "witch_runtime_component_call",
            arguments: {
              componentType: spec.componentType,
              instanceId: object.instanceId,
              path: object.path,
              methodName: method.name,
              arguments: [],
              dryRun: true
            }
          }
        });
        if (operations.length >= maxPerComponent) {
          return { operations, unmapped };
        }
      }
    }
  }

  return { operations, unmapped };
}

function runtimeActionSpecs() {
  return [
    {
      componentType: "NormalMapManager",
      methods: [
        { name: "ShowMapSelect", action: "show_map_select", label: "显示地图选择" },
        { name: "ReadyToChangeMap", action: "map_ready_to_change", label: "准备切换地图" },
        { name: "CloseMapUI", action: "close_map_ui", label: "关闭地图界面" }
      ]
    },
    {
      componentType: "MapManager",
      methods: [
        { name: "CmdReadyToNextMap", action: "map_ready_to_next", label: "准备进入下一地图" },
        { name: "CmdNextMap", action: "map_next", label: "进入下一地图" },
        { name: "TryChange", action: "map_try_change", label: "尝试切换地图" },
        { name: "CloseMapUI", action: "close_map_ui", label: "关闭地图界面" }
      ]
    },
    {
      componentType: "FightManager",
      methods: [
        { name: "ReadyToStart", action: "battle_ready_to_start", label: "准备开始战斗" },
        { name: "EndPlayerturn", action: "battle_end_player_turn", label: "结束玩家回合" },
        { name: "TurnEnd", action: "battle_turn_end", label: "结束回合" },
        { name: "RpcFightCheck", action: "battle_check", label: "战斗检查" }
      ]
    }
  ];
}

async function executeOperation(args) {
  const controlMap = await collectControlMap({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeActions: args?.includeActions !== false,
    includeUi: args?.includeUi !== false,
    includeScene: args?.includeScene !== false,
    includeBattle: args?.includeBattle !== false,
    includeRuntimeActions: args?.includeRuntimeActions !== false,
    includeUnsupported: true,
    maxActions: 200,
    maxUiNodes: 200,
    maxSceneObjects: 200,
    maxRuntimeActions: 50,
    maxRuntimeObjects: 20
  });

  if (!controlMap.ok) {
    return { ok: false, dryRun: args?.dryRun !== false, reason: "control_map_unavailable", controlMap };
  }

  const selected = selectOperation(controlMap.operations || [], args || {});
  if (!selected) {
    return {
      ok: false,
      dryRun: args?.dryRun !== false,
      reason: "no_matching_operation",
      selector: operationSelectorSummary(args || {}),
      available: summarizeAvailableOperations(controlMap.operations || []),
      controlMap: args?.includeControlMap ? controlMap : undefined
    };
  }

  if (selected.noMouse !== true || selected.call?.tool === "witch_input_mouse") {
    return {
      ok: false,
      dryRun: args?.dryRun !== false,
      reason: "operation_is_not_no_mouse",
      selected,
      controlMap: args?.includeControlMap ? controlMap : undefined
    };
  }

  const dryRun = args?.dryRun !== false;
  if (!dryRun && selected.ready === false && args?.allowIncomplete !== true && args?.arguments == null) {
    return {
      ok: false,
      dryRun,
      reason: "operation_requires_arguments",
      selected,
      required: selected.requiresArguments || [],
      controlMap: args?.includeControlMap ? controlMap : undefined
    };
  }

  const plannedCall = {
    tool: selected.call.tool,
    arguments: { ...(selected.call.arguments || {}), ...(args?.arguments || {}) }
  };
  const response = {
    ok: true,
    dryRun,
    selected,
    plannedCall,
    controlMap: args?.includeControlMap ? controlMap : undefined
  };
  const requiresStateProof = operationRequiresStateProof(selected);
  if (requiresStateProof) {
    response.stateProofRequired = true;
    response.preState = await collectOperationStateFingerprint({
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
  }

  if (dryRun) {
    response.result = { ok: true, skipped: true, plannedTool: plannedCall.tool, arguments: plannedCall.arguments };
    return response;
  }

  response.result = await executeRecommendedCall(plannedCall, { forceDryRun: false });
  response.ok = response.result?.ok !== false;
  if (requiresStateProof) {
    const delayMs = Math.max(0, Math.min(5000, Number(args?.postVerifyDelayMs ?? 750)));
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    response.postState = await collectOperationStateFingerprint({
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
    response.stateProof = compareOperationStateFingerprints(response.preState, response.postState);
    if (response.result?.ok !== false && response.stateProof.changed !== true && args?.allowUnverifiedSuccess !== true) {
      response.ok = false;
      response.reason = "operation_unverified_no_state_change";
      response.message = "The underlying call returned success, but MCP could not prove that the map/game state advanced. Treat this as not successful unless allowUnverifiedSuccess is explicitly set.";
    }
  }
  if (args?.includePostSummary) {
    response.postSummary = await collectStateSummary({
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
  }
  return response;
}

function operationRequiresStateProof(operation) {
  const text = normalizeText([
    operation?.id,
    operation?.family,
    operation?.action,
    operation?.label,
    operation?.target?.componentType,
    operation?.target?.methodName,
    operation?.call?.tool,
    operation?.call?.arguments?.methodName
  ].filter(Boolean).join(" "));
  return /(map_continue|map_next|nextmap|cmdnextmap|cmdreadytonextmap|map_ready_to_next|map_try_change|trychange|进入下一地图|继续地图|推进地图)/i.test(text);
}

async function collectOperationStateFingerprint(args) {
  const trace = await collectEventRouteTrace({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeComponentDetails: true,
    includeHookLog: false,
    maxUiNodes: 40,
    maxActions: 80,
    maxRuntimeObjects: 20,
    maxMembersPerComponent: 40
  });
  const snapshot = await collectGameSnapshot({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeUi: true,
    includeScene: false,
    includeBattle: false,
    includeLegalActions: true
  });
  const uiData = snapshot.ui?.data || snapshot.ui || {};
  const legalActions = legalActionsFrom(snapshot.legalActions).map(summarizeAction);
  const fingerprint = {
    ok: trace.ok === true || snapshot.ok === true,
    capturedAtUtc: new Date().toISOString(),
    traceOk: trace.ok === true,
    snapshotOk: snapshot.ok === true,
    activeWindows: (trace.activeWindows || []).map(item => item.windowName || item.nodeId || item.transformPath).filter(Boolean),
    eventCandidates: (trace.eventCandidates || []).slice(0, 20).map(item => item.value),
    mapCandidates: (trace.mapCandidates || []).slice(0, 20).map(item => item.value),
    legalActions: legalActions.slice(0, 40).map(item => item.id || item.kind || item.label).filter(Boolean),
    layoutSignature: fieldValue(uiData, "LayoutSignature") || null,
    visibleUiText: arrayValue(uiData, "Nodes")
      .filter(item => fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false)
      .map(item => fieldValue(item, "Label") || fieldValue(item, "Text"))
      .filter(Boolean)
      .slice(0, 40)
  };
  fingerprint.signature = JSON.stringify({
    activeWindows: fingerprint.activeWindows,
    eventCandidates: fingerprint.eventCandidates,
    mapCandidates: fingerprint.mapCandidates,
    legalActions: fingerprint.legalActions,
    layoutSignature: fingerprint.layoutSignature,
    visibleUiText: fingerprint.visibleUiText
  });
  return fingerprint;
}

function compareOperationStateFingerprints(before, after) {
  const changedFields = [];
  if (!before?.ok || !after?.ok) {
    return {
      changed: false,
      reason: "fingerprint_unavailable",
      beforeOk: before?.ok === true,
      afterOk: after?.ok === true,
      changedFields
    };
  }
  for (const field of ["activeWindows", "eventCandidates", "mapCandidates", "legalActions", "layoutSignature", "visibleUiText"]) {
    if (JSON.stringify(before[field] || null) !== JSON.stringify(after[field] || null)) {
      changedFields.push(field);
    }
  }
  return {
    changed: changedFields.length > 0,
    changedFields,
    beforeSignature: before.signature,
    afterSignature: after.signature
  };
}

async function waitForStateChange(before, waitFor) {
  const timeoutMs = Math.max(0, Math.min(30000, Number(waitFor?.timeoutMs ?? 3000)));
  const pollMs = Math.max(50, Math.min(5000, Number(waitFor?.pollMs ?? 150)));
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    last = await collectOperationStateFingerprint({ includeHidden: false, onlyInteractive: true });
    const diff = compareOperationStateFingerprints(before, last);
    const fields = diff.changedFields || [];
    const matched = (
      (waitFor?.windowChanged === true && fields.includes("activeWindows")) ||
      (waitFor?.layoutChanged === true && fields.includes("layoutSignature")) ||
      (waitFor?.stateChanged === true && diff.changed === true) ||
      (!waitFor?.windowChanged && !waitFor?.layoutChanged && !waitFor?.stateChanged && diff.changed === true)
    );
    if (matched) {
      return { ok: true, changed: true, timedOut: false, waitedMs: Date.now() - startedAt, diff, current: last };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  const diff = compareOperationStateFingerprints(before, last);
  return { ok: false, changed: false, timedOut: true, waitedMs: Date.now() - startedAt, diff, current: last };
}

async function executeRuntimeComponentCall(args, options = {}) {
  const componentArgs = { ...args, dryRun: options?.forceDryRun ? true : args?.dryRun !== false };
  if (componentArgs.dryRun) {
    delete componentArgs.confirm;
  }
  const waitFor = componentArgs.waitFor;
  delete componentArgs.waitFor;
  const shouldWait = !componentArgs.dryRun && waitFor && typeof waitFor === "object";
  const before = shouldWait ? await collectOperationStateFingerprint({ includeHidden: false, onlyInteractive: true }) : null;
  const result = await callBridge("runtime.component_call", componentArgs);
  const response = { ...result };
  if (shouldWait) {
    response.beforeState = before;
    response.wait = await waitForStateChange(before, waitFor);
    response.afterState = response.wait?.current || null;
    response.stateDiff = response.wait?.diff || null;
    if (result?.ok !== false && response.wait?.changed !== true && args?.allowUnverifiedSuccess !== true) {
      response.ok = false;
      response.reason = "runtime_call_unverified_no_state_change";
      response.message = "The component method call returned success, but the requested waitFor condition did not become true.";
    }
  }
  return response;
}

async function probeNoMouseOperation(args) {
  const diagnostics = await runtimeDiagnostics({ includeLogTail: false });
  const result = await executeOperation({
    ...args,
    dryRun: args?.dryRun !== false,
    includeControlMap: args?.includeControlMap === true
  });
  const selected = result?.selected || null;
  const fakeBridge = diagnostics.bridgeStatus?.data?.bridge === "fake";
  const probe = {
    capturedAtUtc: new Date().toISOString(),
    note: typeof args?.note === "string" ? args.note.slice(0, 240) : "",
    dryRun: result?.dryRun !== false,
    executed: result?.dryRun === false,
    ok: result?.ok === true,
    noMouse: selected?.noMouse === true && selected?.call?.tool !== "witch_input_mouse",
    family: selected?.family || args?.family || null,
    action: selected?.action || args?.action || null,
    operationId: selected?.id || args?.operationId || null,
    label: selected?.label || args?.label || null,
    operation: selected ? summarizeOperationForProof(selected) : null,
    plannedCall: result?.plannedCall || null,
    result: compactProbeResult(result),
    bridge: {
      fakeBridge,
      statusOk: diagnostics.bridgeStatus?.ok === true,
      name: diagnostics.bridgeStatus?.data?.bridge || null
    }
  };

  let summary = null;
  if (args?.recordEvidence !== false) {
    const log = await readNoMouseEvidenceLog();
    const merged = {
      ...emptyNoMouseEvidenceLog(),
      ...log,
      updatedAtUtc: probe.capturedAtUtc,
      operationProbes: mergeOperationProbeEvidence(log.operationProbes || {}, probe)
    };
    await writeNoMouseEvidenceLog(merged);
    summary = summarizeNoMouseEvidenceLog(merged);
  }

  return {
    ok: probe.ok,
    recorded: args?.recordEvidence !== false,
    path: args?.recordEvidence !== false ? NO_MOUSE_EVIDENCE_LOG_PATH : null,
    probe,
    summary
  };
}

async function collectReadyNoMouseEvidence(args) {
  const dryRun = args?.dryRun !== false;
  if (!dryRun && args?.confirm !== "EXECUTE_NO_MOUSE_PROBES") {
    return {
      ok: false,
      dryRun,
      reason: "probe_execution_confirmation_required",
      nextStep: "Pass confirm:\"EXECUTE_NO_MOUSE_PROBES\" only after reviewing the selected no-mouse operations."
    };
  }

  const maxProbes = Math.max(0, Math.min(50, Number(args?.maxProbes ?? 8)));
  const plan = await noMouseEvidencePlan({
    includeCurrentState: true,
    includePolicyTests: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeControlMap: args?.includeControlMap === true
  });
  const candidates = args?.onlyMissing === false
    ? await collectReadyNoMouseCandidatesFromControlMap(args || {})
    : collectReadyNoMouseCandidatesFromPlan(plan);
  const selected = dedupeOperationCandidates(candidates).slice(0, maxProbes);
  const probes = [];

  for (const candidate of selected) {
    const probe = await probeNoMouseOperation({
      operationId: candidate.operationId,
      dryRun,
      recordEvidence: args?.recordEvidence !== false,
      note: candidate.note || "collect ready no-mouse evidence",
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
    probes.push({ candidate, probe });
  }

  const stateSample = args?.recordStateSample === false
    ? null
    : await recordNoMouseEvidence({
      note: "collect ready no-mouse evidence state sample",
      includePolicyTests: false,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
  const postAudit = args?.includePostAudit === false
    ? null
    : await noMouseCompletionAudit({
      includeCurrentState: true,
      includePolicyTests: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });

  return {
    ok: probes.every(item => item.probe?.ok !== false),
    dryRun,
    capturedAtUtc: new Date().toISOString(),
    selectedCount: selected.length,
    maxProbes,
    onlyMissing: args?.onlyMissing !== false,
    completeBefore: plan.complete === true,
    completeAfter: postAudit ? postAudit.complete === true : null,
    probes,
    stateSample,
    postAudit,
    plan: args?.includePlan === false ? undefined : plan
  };
}

async function driveNoMouseEvidence(args) {
  const dryRun = args?.dryRun !== false;
  if (!dryRun && args?.confirm !== "EXECUTE_NO_MOUSE_PROBES") {
    return {
      ok: false,
      dryRun,
      reason: "probe_execution_confirmation_required",
      nextStep: "Pass confirm:\"EXECUTE_NO_MOUSE_PROBES\" only after reviewing the selected no-mouse operations."
    };
  }

  const maxRounds = Math.max(1, Math.min(20, Number(args?.maxRounds ?? 3)));
  const maxProbesPerRound = Math.max(0, Math.min(50, Number(args?.maxProbesPerRound ?? 8)));
  const waitAfterMs = Math.max(0, Math.min(10000, Number(args?.waitAfterMs ?? 250)));
  const rounds = [];
  let finalAudit = await noMouseCompletionAudit({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });

  if (finalAudit.complete === true) {
    return {
      ok: true,
      complete: true,
      dryRun,
      stopped: true,
      reason: "already_complete",
      rounds,
      finalAudit,
      finalPlan: args?.includePlan === false ? null : await noMouseEvidencePlan({
        includePolicyTests: true,
        includeCurrentState: true,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      })
    };
  }

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const plan = await noMouseEvidencePlan({
      includePolicyTests: true,
      includeCurrentState: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
    const collection = await collectReadyNoMouseEvidence({
      dryRun,
      confirm: args?.confirm,
      onlyMissing: args?.onlyMissing !== false,
      maxProbes: maxProbesPerRound,
      recordEvidence: true,
      recordStateSample: true,
      includePlan: false,
      includeControlMap: false,
      includePostAudit: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });

    finalAudit = collection.postAudit || finalAudit;
    rounds.push({
      index: roundIndex,
      plan: args?.includePlan === false ? undefined : plan,
      collection,
      completeAfterRound: finalAudit?.complete === true
    });

    if (finalAudit?.complete === true) {
      return { ok: true, complete: true, dryRun, stopped: true, reason: "complete", rounds, finalAudit };
    }

    if (collection.selectedCount === 0 && args?.stopWhenNoReady !== false) {
      const finalPlan = args?.includePlan === false ? null : await noMouseEvidencePlan({
        includePolicyTests: true,
        includeCurrentState: true,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      });
      return {
        ok: true,
        complete: false,
        dryRun,
        stopped: true,
        reason: "no_ready_probe",
        nextStep: "Enter a game state that exposes one of the missing legal-action, scene, or battle operation types, then run this tool again.",
        rounds,
        finalAudit,
        stateAdvanceCandidates: finalPlan?.stateAdvanceCandidates || [],
        finalPlan
      };
    }

    if (waitAfterMs > 0 && roundIndex < maxRounds - 1) {
      await new Promise(resolve => setTimeout(resolve, waitAfterMs));
    }
  }

  return {
    ok: true,
    complete: finalAudit?.complete === true,
    dryRun,
    stopped: true,
    reason: "max_rounds",
    rounds,
    finalAudit,
    finalPlan: args?.includePlan === false ? null : await noMouseEvidencePlan({
      includePolicyTests: true,
      includeCurrentState: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    })
  };
}

async function watchNoMouseEvidence(args) {
  const dryRun = args?.dryRun !== false;
  if (!dryRun && args?.confirm !== "EXECUTE_NO_MOUSE_PROBES") {
    return {
      ok: false,
      dryRun,
      reason: "probe_execution_confirmation_required",
      nextStep: "Pass confirm:\"EXECUTE_NO_MOUSE_PROBES\" only after reviewing the selected no-mouse operations."
    };
  }

  const timeoutMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(args?.timeoutMs ?? 60000)));
  const pollMs = Math.max(100, Math.min(60000, Number(args?.pollMs ?? 1000)));
  const maxCollections = Math.max(0, Math.min(100, Number(args?.maxCollections ?? 5)));
  const maxProbesPerCollection = Math.max(0, Math.min(50, Number(args?.maxProbesPerCollection ?? 8)));
  const startedAt = Date.now();
  const events = [];
  const collections = [];
  let lastPlan = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    const plan = await noMouseEvidencePlan({
      includePolicyTests: true,
      includeCurrentState: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
    lastPlan = plan;
    events.push({
      elapsedMs,
      type: "plan",
      complete: plan.complete === true,
      readyProbeCount: plan.readyProbeCount || 0,
      missingCount: plan.missingCount || 0,
      stateAdvanceCount: Array.isArray(plan.stateAdvanceCandidates) ? plan.stateAdvanceCandidates.length : 0
    });

    if (plan.complete === true) {
      return {
        ok: true,
        complete: true,
        dryRun,
        timedOut: false,
        reason: "already_complete",
        waitedMs: elapsedMs,
        events,
        collections,
        finalPlan: args?.includePlan === false ? null : plan
      };
    }

    if ((plan.readyProbeCount || 0) > 0 && collections.length < maxCollections) {
      const collection = await collectReadyNoMouseEvidence({
        dryRun,
        confirm: args?.confirm,
        onlyMissing: true,
        maxProbes: maxProbesPerCollection,
        recordEvidence: true,
        recordStateSample: true,
        includePlan: false,
        includeControlMap: false,
        includePostAudit: true,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      });
      collections.push({ elapsedMs: Date.now() - startedAt, collection });
      events.push({
        elapsedMs: Date.now() - startedAt,
        type: "collection",
        selectedCount: collection.selectedCount,
        completeAfter: collection.completeAfter === true
      });
      if (collection.completeAfter === true || collection.postAudit?.complete === true) {
        return {
          ok: true,
          complete: true,
          dryRun,
          timedOut: false,
          reason: "complete",
          waitedMs: Date.now() - startedAt,
          events,
          collections,
          finalAudit: collection.postAudit,
          finalPlan: args?.includePlan === false ? null : await noMouseEvidencePlan({
            includePolicyTests: true,
            includeCurrentState: true,
            includeHidden: !!args?.includeHidden,
            onlyInteractive: args?.onlyInteractive !== false
          })
        };
      }
    }

    if (collections.length >= maxCollections && maxCollections > 0) {
      return {
        ok: true,
        complete: false,
        dryRun,
        timedOut: false,
        reason: "max_collections",
        waitedMs: Date.now() - startedAt,
        events,
        collections,
        finalPlan: args?.includePlan === false ? null : lastPlan
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return {
    ok: true,
    complete: false,
    dryRun,
    timedOut: true,
    reason: "timeout",
    waitedMs: Date.now() - startedAt,
    events,
    collections,
    finalPlan: args?.includePlan === false ? null : lastPlan,
    stateAdvanceCandidates: lastPlan?.stateAdvanceCandidates || []
  };
}

async function driveNoMouseStateAdvance(args) {
  const dryRun = args?.dryRun !== false;
  if (!dryRun && args?.confirm !== "ADVANCE_NO_MOUSE_STATE") {
    return {
      ok: false,
      dryRun,
      reason: "state_advance_confirmation_required",
      nextStep: "Pass confirm:\"ADVANCE_NO_MOUSE_STATE\" only after reviewing stateAdvanceCandidates; this may change in-game state."
    };
  }

  const probeDryRun = args?.probeDryRun !== false;
  if (!probeDryRun && args?.probeConfirm !== "EXECUTE_NO_MOUSE_PROBES") {
    return {
      ok: false,
      dryRun,
      probeDryRun,
      reason: "probe_execution_confirmation_required",
      nextStep: "Pass probeConfirm:\"EXECUTE_NO_MOUSE_PROBES\" only after reviewing the selected no-mouse probes."
    };
  }

  const maxSteps = Math.max(1, Math.min(20, Number(args?.maxSteps ?? 3)));
  const maxProbesPerStep = Math.max(0, Math.min(50, Number(args?.maxProbesPerStep ?? 6)));
  const waitAfterAdvanceMs = Math.max(0, Math.min(10000, Number(args?.waitAfterAdvanceMs ?? 500)));
  const requestedCandidateIndex = Math.max(0, Math.min(50, Number(args?.candidateIndex ?? 0)));
  const steps = [];
  const attemptedOperationIds = new Set();
  let finalAudit = await noMouseCompletionAudit({
    includePolicyTests: true,
    includeCurrentState: true,
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false
  });

  if (finalAudit.complete === true) {
    return {
      ok: true,
      complete: true,
      dryRun,
      probeDryRun,
      stopped: true,
      reason: "already_complete",
      steps,
      finalAudit,
      finalPlan: args?.includePlan === false ? null : await noMouseEvidencePlan({
        includePolicyTests: true,
        includeCurrentState: true,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      })
    };
  }

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const plan = await noMouseEvidencePlan({
      includePolicyTests: true,
      includeCurrentState: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });
    let collection = null;
    if (args?.collectReadyBeforeAdvance !== false && (plan.readyProbeCount || 0) > 0) {
      collection = await collectReadyNoMouseEvidence({
        dryRun: probeDryRun,
        confirm: args?.probeConfirm,
        onlyMissing: true,
        maxProbes: maxProbesPerStep,
        recordEvidence: true,
        recordStateSample: true,
        includePlan: false,
        includeControlMap: false,
        includePostAudit: true,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      });
      finalAudit = collection.postAudit || finalAudit;
      if (finalAudit?.complete === true) {
        steps.push({
          index: stepIndex,
          plan: args?.includePlan === false ? undefined : plan,
          collection,
          advance: null,
          completeAfterStep: true
        });
        return { ok: true, complete: true, dryRun, probeDryRun, stopped: true, reason: "complete", steps, finalAudit };
      }
    }

    const rawCandidates = (plan.stateAdvanceCandidates || [])
      .filter(candidate => candidate?.operation?.id && !attemptedOperationIds.has(candidate.operation.id));
    const policyResults = rawCandidates.map(candidate => ({
      candidate,
      policy: evaluateStateAdvancePolicy(candidate.operation, args || {})
    }));
    const candidates = policyResults
      .filter(item => item.policy.ok)
      .map(item => item.candidate);
    const blockedCandidates = policyResults
      .filter(item => !item.policy.ok)
      .map(item => ({
        operation: item.candidate.operation,
        policy: item.policy
      }));
    const selectedCandidate = candidates[Math.min(requestedCandidateIndex, Math.max(0, candidates.length - 1))] || null;
    if (!selectedCandidate) {
      steps.push({
        index: stepIndex,
        plan: args?.includePlan === false ? undefined : plan,
        collection,
        advance: null,
        blockedCandidates,
        completeAfterStep: false
      });
      return {
        ok: true,
        complete: false,
        dryRun,
        probeDryRun,
        stopped: true,
        reason: rawCandidates.length > 0 ? "state_advance_policy_filtered" : "no_state_advance_candidate",
        nextStep: rawCandidates.length > 0
          ? "Relax allow/deny filters or choose an allowed no-mouse state advance operation."
          : "Enter or expose a state-advanceable no-mouse operation, or restart the game if bridge DLL readiness is the remaining blocker.",
        steps,
        blockedCandidates,
        finalAudit,
        finalPlan: args?.includePlan === false ? null : plan
      };
    }

    attemptedOperationIds.add(selectedCandidate.operation.id);
    const advance = await executeOperation({
      operationId: selectedCandidate.operation.id,
      dryRun,
      includePostSummary: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });

    if (waitAfterAdvanceMs > 0 && !dryRun) {
      await new Promise(resolve => setTimeout(resolve, waitAfterAdvanceMs));
    }

    const stateSample = args?.recordEvidence === false
      ? null
      : await recordNoMouseEvidence({
        note: dryRun
          ? "dry-run no-mouse state advance candidate"
          : "post no-mouse state advance sample",
        includePolicyTests: false,
        includeHidden: !!args?.includeHidden,
        onlyInteractive: args?.onlyInteractive !== false
      });
    finalAudit = await noMouseCompletionAudit({
      includePolicyTests: true,
      includeCurrentState: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    });

    steps.push({
      index: stepIndex,
      plan: args?.includePlan === false ? undefined : plan,
      collection,
      selectedCandidate,
      advance,
      stateSample,
      completeAfterStep: finalAudit.complete === true
    });

    if (finalAudit.complete === true) {
      return { ok: true, complete: true, dryRun, probeDryRun, stopped: true, reason: "complete", steps, finalAudit };
    }

    if (dryRun && args?.stopAfterDryRunPlan !== false) {
      return {
        ok: true,
        complete: false,
        dryRun,
        probeDryRun,
        stopped: true,
        reason: "dry_run_planned",
        nextStep: "Review steps[0].selectedCandidate and rerun with dryRun:false plus confirm:\"ADVANCE_NO_MOUSE_STATE\" when this state change is acceptable.",
        steps,
        finalAudit,
        finalPlan: args?.includePlan === false ? null : await noMouseEvidencePlan({
          includePolicyTests: true,
          includeCurrentState: true,
          includeHidden: !!args?.includeHidden,
          onlyInteractive: args?.onlyInteractive !== false
        })
      };
    }
  }

  return {
    ok: true,
    complete: finalAudit?.complete === true,
    dryRun,
    probeDryRun,
    stopped: true,
    reason: "max_steps",
    steps,
    finalAudit,
    finalPlan: args?.includePlan === false ? null : await noMouseEvidencePlan({
      includePolicyTests: true,
      includeCurrentState: true,
      includeHidden: !!args?.includeHidden,
      onlyInteractive: args?.onlyInteractive !== false
    })
  };
}

async function collectReadyNoMouseCandidatesFromControlMap(args) {
  const controlMap = await collectControlMap({
    includeHidden: !!args?.includeHidden,
    onlyInteractive: args?.onlyInteractive !== false,
    includeActions: true,
    includeUi: true,
    includeScene: true,
    includeBattle: true,
    includeUnsupported: false
  });
  const operations = Array.isArray(controlMap.operations) ? controlMap.operations : [];
  return operations
    .filter(operation => operation?.ready !== false && operation?.noMouse === true && operation?.call?.tool !== "witch_input_mouse")
    .map(operation => ({
      operationId: operation.id,
      family: operation.family,
      action: operation.action,
      label: operation.label,
      note: "collect ready no-mouse evidence: " + operation.family + "/" + operation.action
    }));
}

function collectReadyNoMouseCandidatesFromPlan(plan) {
  const steps = Array.isArray(plan?.operationProofSteps) ? plan.operationProofSteps : [];
  return steps
    .filter(step => step.status === "ready_in_current_state" && step.dryRunCall?.arguments?.operationId)
    .map(step => ({
      operationId: step.dryRunCall.arguments.operationId,
      family: step.family,
      action: step.action,
      label: step.operation?.label || null,
      note: "collect missing no-mouse evidence: " + step.family + "/" + step.action
    }));
}

function dedupeOperationCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.operationId || [candidate.family, candidate.action, candidate.label].join(":");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function compactProbeResult(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    dryRun: result.dryRun,
    reason: result.reason || null,
    error: result.error || null,
    plannedCall: result.plannedCall || null,
    result: result.result
  };
}

function selectOperation(operations, selector) {
  let candidates = operations.slice();
  if (selector.operationId) {
    candidates = candidates.filter(operation => operation.id === selector.operationId);
  }
  if (selector.family) {
    candidates = candidates.filter(operation => matchesText(operation.family, selector.family, false));
  }
  if (selector.action) {
    candidates = candidates.filter(operation => normalizeActionName(operation.action) === normalizeActionName(selector.action));
  }
  if (selector.label) {
    const contains = selector.contains !== false;
    candidates = candidates.filter(operation => matchesText(operation.label, selector.label, contains));
  }
  if (Number.isInteger(selector.index)) {
    return candidates[selector.index] || null;
  }
  return candidates[0] || null;
}

function operationSelectorSummary(selector) {
  return {
    operationId: selector.operationId || null,
    family: selector.family || null,
    action: selector.action || null,
    label: selector.label || null,
    index: Number.isInteger(selector.index) ? selector.index : null,
    contains: selector.contains !== false
  };
}

function summarizeAvailableOperations(operations) {
  return operations.slice(0, 30).map((operation, index) => ({
    index,
    id: operation.id,
    family: operation.family,
    action: operation.action,
    label: operation.label,
    ready: operation.ready,
    noMouse: operation.noMouse,
    requiresArguments: operation.requiresArguments || []
  }));
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
  const summary = {
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
    suggestedNextAction: suggestedAction ? summarizeAction(suggestedAction) : null,
    snapshotSources: {
      ui: snapshotSourceEvidence(snapshot.ui),
      scene: snapshotSourceEvidence(snapshot.scene),
      legalActions: snapshotSourceEvidence(snapshot.legalActions),
      battle: snapshotSourceEvidence(snapshot.battle)
    }
  };
  if (args?.compact === true) {
    summary.ui = compactSummaryUi(summary.ui);
    summary.scene = {
      sceneName: summary.scene.sceneName,
      count: summary.scene.count,
      objects: summary.scene.objects.slice(0, Math.min(10, limit(args?.maxSceneObjects, 20))).map(item => ({
        name: item.name,
        objectId: item.objectId,
        transformPath: item.transformPath,
        supportedActions: item.supportedActions
      }))
    };
  }
  return applyFieldFilter(summary, args?.fields);
}

function compactSummaryUi(ui) {
  return {
    totalNodes: ui.totalNodes,
    visibleNodes: ui.visibleNodes,
    layoutSignature: ui.layoutSignature,
    activeWindows: (ui.activeWindows || []).map(item => item.windowName || item.transformPath).filter(Boolean),
    clickables: (ui.clickableNodes || []).slice(0, 20).map(item => ({
      label: item.label || item.text || null,
      nodeId: item.nodeId,
      windowName: item.windowName,
      transformPath: item.transformPath,
      supportedActions: item.supportedActions
    }))
  };
}

function applyFieldFilter(object, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return object;
  const result = { ok: object?.ok !== false };
  for (const field of fields) {
    if (field in object) result[field] = object[field];
    if (field === "activeWindows") result.activeWindows = object?.ui?.activeWindows || [];
    if (field === "clickables") result.clickables = object?.ui?.clickables || object?.ui?.clickableNodes || [];
    if (field === "titles") result.titles = object?.ui?.titles || [];
    if (field === "legalActions") result.legalActions = object?.legalActions;
  }
  return result;
}

function snapshotSourceEvidence(result) {
  return {
    ok: result?.ok !== false,
    source: result?.source || result?.command || null,
    fallbackFrom: result?.fallbackFrom || null,
    fallbackReason: result?.fallbackReason || null
  };
}

function summarizeUi(ui, args) {
  const nodes = arrayValue(ui, "Nodes");
  const windows = arrayValue(ui, "Windows");
  const visibleNodes = nodes.filter(item => args?.includeHidden || (fieldValue(item, "Visible") !== false && fieldValue(item, "ActiveInHierarchy") !== false));
  return {
    totalNodes: fieldValue(ui, "TotalNodes") ?? nodes.length,
    visibleNodes: visibleNodes.length,
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
    clickableNodes: visibleNodes
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
  const inferred = [];
  if (fieldValue(item, "Clickable") === true) inferred.push("click", "submit", "hover");
  if (isEditableUiNode(item)) inferred.push("set_text", "submit");
  if (hasUiRect(item)) inferred.push("hover", "drag", "scroll");
  return mergeActionNames(actions, inferred);
}

function sceneActionsForObject(item) {
  const actions = normalizedActions(item);
  const inferred = [];
  if (fieldValue(item, "Interactive") !== false) inferred.push("click", "hover");
  if (fieldValue(item, "HasCollider3D") === true || fieldValue(item, "HasCollider2D") === true || fieldValue(item, "HasPointerHandler") === true) {
    inferred.push("drag", "scroll");
  }
  return mergeActionNames(actions, inferred);
}

function normalizedActions(item) {
  const actions = fieldValue(item, "SupportedActions") ?? [];
  if (!Array.isArray(actions)) return [];
  return [...new Set(actions.map(action => normalizeActionName(action)).filter(Boolean))];
}

function mergeActionNames(primary, secondary) {
  return [...new Set([...(primary || []), ...(secondary || [])].map(action => normalizeActionName(action)).filter(Boolean))];
}

function hasUiRect(item) {
  return fieldValue(item, "ScreenRect") != null || fieldValue(item, "PreferredClickPoint") != null;
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
    case "submit":
      return { submit: true };
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

function compactPlayCardArgs(card, fallbackIndex) {
  return pruneUndefined({
    cardInstanceId: Number.isInteger(card?.instanceId) ? card.instanceId : undefined,
    cardId: card?.cardId || undefined,
    cardIndex: Number.isInteger(card?.cardIndex) ? card.cardIndex : fallbackIndex
  });
}

function compactPlayTargetArgs(target, fallbackIndex) {
  return pruneUndefined({
    targetInstanceId: Number.isInteger(target?.instanceId) ? target.instanceId : undefined,
    targetName: target?.targetName || target?.objectName || undefined,
    targetIndex: Number.isInteger(target?.targetIndex) ? target.targetIndex : fallbackIndex
  });
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
      return performLegalAction({ actionId: args.actionId });
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
      return interactUi(uiClickLabelArgs(args));
    case "witch_ui_interact":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return interactUi(args);
    case "witch_scene_interact":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return interactScene(args);
    case "witch_play_card":
      if (options?.forceDryRun) {
        return { ok: true, skipped: true, plannedTool: call.tool, arguments: args };
      }
      return playBattleCard(args);
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
      return executeRuntimeComponentCall(args, options || {});
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
    case "witch_event_route_trace":
      return collectEventRouteTrace(args);
    case "witch_assert_route":
      return assertRoute(args);
    case "witch_assert_ui_text":
      return assertUiText(args);
    case "witch_assert_event_id":
      return assertEventId(args);
    case "witch_assert_forbidden_text":
      return assertForbiddenText(args);
    case "witch_event_choose_option":
      return chooseEventOption(args);
    case "witch_story_map_snapshot":
      return collectStoryMapSnapshot(args);
    case "witch_log_tail":
      return logTail(args);
    case "witch_screenshot":
      return captureScreenshotSummary(args);
    case "witch_map_select_node":
      return selectMapNode(args);
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
    case "witch_sync_bridge_artifacts":
      return syncBridgeArtifacts({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_no_mouse_restart_collect_audit":
      return restartCollectNoMouseAudit(args);
    case "witch_no_mouse_restart_advance_audit":
      return restartAdvanceNoMouseAudit(args);
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
    case "witch_no_mouse_record_evidence":
      return recordNoMouseEvidence(args);
    case "witch_no_mouse_completion_audit":
      return noMouseCompletionAudit(args);
    case "witch_no_mouse_evidence_plan":
      return noMouseEvidencePlan(args);
    case "witch_no_mouse_probe_operation":
      return probeNoMouseOperation({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_no_mouse_collect_ready_evidence":
      return collectReadyNoMouseEvidence({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_no_mouse_evidence_drive":
      return driveNoMouseEvidence({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_no_mouse_state_advance_drive":
      return driveNoMouseStateAdvance({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_no_mouse_watch_evidence":
      return watchNoMouseEvidence({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_status":
      return safeCallBridge("status", {});
    case "witch_game_snapshot":
      return collectGameSnapshot(args);
    case "witch_control_map":
      return collectControlMap(args);
    case "witch_event_route_trace":
      return collectEventRouteTrace(args);
    case "witch_assert_route":
      return assertRoute(args);
    case "witch_assert_ui_text":
      return assertUiText(args);
    case "witch_assert_event_id":
      return assertEventId(args);
    case "witch_assert_forbidden_text":
      return assertForbiddenText(args);
    case "witch_event_choose_option":
      return chooseEventOption({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_story_map_snapshot":
      return collectStoryMapSnapshot(args);
    case "witch_log_tail":
      return logTail(args);
    case "witch_screenshot":
      return captureScreenshotSummary(args);
    case "witch_map_select_node":
      return selectMapNode({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_execute_operation":
      return executeOperation({ ...args, dryRun: options?.dryRun ? true : args.dryRun !== false });
    case "witch_battle_snapshot":
      return collectBattleSnapshot(args);
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
      return collectLegalActions(args);
    case "witch_ui_snapshot":
      return collectUiSnapshot(args);
    case "witch_scene_snapshot":
      return collectSceneSnapshot(args);
    case "witch_scene_raycast":
      return raycastScene(args);
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
    case "witch_play_card":
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

function containsText(value, query) {
  return normalizeText(value).includes(normalizeText(query));
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
  const legal = await collectLegalActions({});
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

  const result = await performLegalAction({ actionId });
  return { ok: result?.ok !== false, selected, result };
}

async function autoStep(args) {
  const legal = await collectLegalActions({});
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

  response.result = await performLegalAction({ actionId });
  response.ok = response.result?.ok !== false;
  return response;
}

async function autoDrive(args) {
  const maxSteps = Math.max(1, Math.min(100, Number(args?.maxSteps ?? 5)));
  const waitAfterMs = Math.max(0, Math.min(10000, Number(args?.waitAfterMs ?? 250)));
  const steps = [];

  for (let i = 0; i < maxSteps; i++) {
    const legal = await collectLegalActions({});
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

    step.result = await performLegalAction({ actionId });
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
