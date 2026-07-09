import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19172;
const calls = [];
let performedActions = 0;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "witch-mcp-test-"));
const capturePath = path.join(tempDir, "capture.png");
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
    calls.push(payload);
    let result;
    switch (payload.command) {
      case "status":
        result = { ok: true, data: { bridge: "fake", version: "test" } };
        break;
      case "ui.snapshot":
        result = {
          ok: true,
          data: {
            TotalNodes: 2,
            LayoutSignature: "layout-test",
            Windows: [{ WindowName: "MainMenu", NodeId: "window-main", Visible: true, ActiveInHierarchy: true }],
            Nodes: [
              { NodeId: "start", Label: "start journey", WindowName: "MainMenu", Clickable: true, SupportedActions: ["click", "submit", "scroll", "drag", "hover"] },
              { NodeId: "title", Label: "title", WindowName: "MainMenu", Clickable: false }
            ]
          }
        };
        break;
      case "scene.snapshot":
        result = {
          ok: true,
          data: {
            SceneName: "MainScene",
            CameraName: "MainCamera",
            TotalObjects: 1,
            Objects: [
              {
                ObjectId: "door",
                Name: "Door",
                SceneName: "MainScene",
                Tag: "Interactable",
                Layer: 5,
                LayerName: "Default",
                Visible: true,
                ActiveInHierarchy: true,
                HasCollider3D: false,
                HasCollider2D: true,
                HasPointerHandler: true,
                Interactive: true,
                ComponentTypes: ["SceneItem"],
                SupportedActions: ["click", "hover", "drag", "scroll"],
                ScreenPoint: { X: 10, Y: 20 },
                ScreenRect: { X: 1, Y: 2, Width: 30, Height: 40 }
              }
            ]
          }
        };
        break;
      case "screen.info":
        result = {
          ok: true,
          data: {
            width: 1280,
            height: 720,
            fullScreen: false,
            activeWindow: 12345,
            windowRect: { left: 10, top: 20, right: 1290, bottom: 740 }
          }
        };
        break;
      case "screen.capture":
        fsSync.writeFileSync(capturePath, pngHeader);
        result = {
          ok: true,
          data: {
            fullPath: capturePath,
            isAsync: true,
            width: 1280,
            height: 720
          }
        };
        break;
      case "window.focus":
        result = {
          ok: true,
          data: {
            requestedWindow: 12345,
            foregroundBefore: 999,
            foregroundAfter: 12345,
            focused: true,
            isForeground: true
          }
        };
        break;
      case "input.key":
      case "input.text":
      case "input.mouse":
        result = { ok: true, data: { command: payload.command, params: payload.params } };
        break;
      case "runtime.inspect":
        result = {
          ok: true,
          data: {
            query: payload.params.query || "",
            types: fakeRuntimeTypes(payload.params.query || "")
          }
        };
        break;
      case "runtime.objects":
        result = {
          ok: true,
          data: {
            query: payload.params.query || "",
            objects: [
              {
                name: "MainCamera",
                instanceId: 77,
                path: "Scene/MainCamera",
                activeInHierarchy: true,
                tag: "MainCamera",
                layerName: "Default",
                components: [{ type: "UnityEngine.Camera", name: "Camera", enabled: true }]
              }
            ]
          }
        };
        break;
      case "runtime.object_detail":
        result = {
          ok: true,
          data: {
            found: true,
            gameObject: { name: "MainCamera", instanceId: payload.params.instanceId || 77, path: "Scene/MainCamera" },
            components: [
              {
                type: "UnityEngine.Camera",
                name: "Camera",
                enabled: true,
                members: [
                  { kind: "property", name: "fieldOfView", type: "System.Single", value: 60 }
                ]
              }
            ]
          }
        };
        break;
      case "runtime.component_members":
        result = {
          ok: true,
          data: {
            found: true,
            gameObject: { name: "MainCamera", instanceId: payload.params.instanceId || 77, path: "Scene/MainCamera" },
            components: [
              {
                type: "UnityEngine.Camera",
                name: "Camera",
                enabled: true,
                membersTruncated: false,
                members: [
                  { kind: "property", name: "fieldOfView", type: "System.Single", readable: true, writable: true },
                  { name: "GetInstanceID", returnType: "System.Int32", parameters: [] }
                ]
              }
            ]
          }
        };
        break;
      case "runtime.component_call":
        result = {
          ok: true,
          data: {
            found: true,
            dryRun: payload.params.dryRun !== false,
            gameObject: { name: "MainCamera", instanceId: payload.params.instanceId || 77, path: "Scene/MainCamera" },
            component: { type: "UnityEngine.Camera", name: "Camera", enabled: true },
            method: {
              name: payload.params.methodName,
              declaringType: "UnityEngine.Object",
              returnType: "System.Int32",
              parameters: []
            },
            result: payload.params.dryRun === false ? 77 : undefined
          }
        };
        break;
      case "runtime.component_set":
        result = {
          ok: true,
          data: {
            found: true,
            dryRun: payload.params.dryRun !== false,
            gameObject: { name: "MainCamera", instanceId: payload.params.instanceId || 77, path: "Scene/MainCamera" },
            component: { type: "UnityEngine.Camera", name: "Camera", enabled: true },
            member: { kind: payload.params.memberKind || "property", name: payload.params.memberName, type: "System.Single", readable: true, writable: true },
            before: 60,
            requestedValue: payload.params.value,
            after: payload.params.dryRun === false ? payload.params.value : undefined
          }
        };
        break;
      case "runtime.invoke_static":
        result = {
          ok: true,
          data: {
            typeName: payload.params.typeName,
            methodName: payload.params.methodName,
            result: { invoked: true }
          }
        };
        break;
      case "game.legal_actions": {
        const running = performedActions < 4;
        result = {
          ok: true,
          data: {
            Phase: running ? "menu" : "done",
            Actions: [
              { Id: "open-map", Kind: "navigation", Label: "open map" },
              { Id: running ? "start-run" : "finish", Kind: running ? "run" : "done", Label: running ? "start journey" : "done" }
            ]
          }
        };
        break;
      }
      case "game.perform_action":
        performedActions += 1;
        result = { ok: true, data: { Success: true, ActionId: payload.params.actionId } };
        break;
      case "battle.snapshot":
        result = {
          ok: true,
          data: {
            capturedAtUtc: new Date().toISOString(),
            inBattle: true,
            cardCount: 1,
            targetCount: 1,
            cards: [
              { index: 0, cardIndex: 0, cardId: "spark", instanceId: 501, objectName: "Spark", playCardCall: { tool: "witch_play_card", arguments: { cardIndex: 0, cardId: "spark" } } }
            ],
            targets: [
              { index: 0, targetIndex: 0, targetName: "Slime", instanceId: 601, objectName: "Slime" }
            ],
            supportedActions: ["play_card"]
          }
        };
        break;
      case "ui.interact":
        result = { ok: true, data: { Success: true, Selector: payload.params.selector } };
        break;
      default:
        result = { ok: false, error: `unexpected ${payload.command}` };
        break;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
});

function fakeRuntimeTypes(query) {
  const services = [
    {
      assembly: "Witch",
      fullName: "Witch.UI.Automation.RuntimeGameplayAutomationService",
      members: [
        { kind: "method", name: "GetLegalActions", isStatic: true, parameters: [] },
        { kind: "method", name: "PerformActionAsync", isStatic: true, parameters: [] }
      ]
    },
    {
      assembly: "Witch",
      fullName: "Witch.UI.Automation.RuntimeUiAutomationService",
      members: [
        { kind: "method", name: "CaptureSnapshot", isStatic: true, parameters: [] },
        { kind: "method", name: "EvaluateWaitCondition", isStatic: true, parameters: [] },
        { kind: "method", name: "InteractAsync", isStatic: true, parameters: [] }
      ]
    },
    {
      assembly: "Witch",
      fullName: "Witch.UI.Automation.RuntimeSceneAutomationService",
      members: [
        { kind: "method", name: "CaptureSnapshot", isStatic: true, parameters: [] },
        { kind: "method", name: "Raycast", isStatic: true, parameters: [] },
        { kind: "method", name: "InteractAsync", isStatic: true, parameters: [] }
      ]
    },
    {
      assembly: "Witch",
      fullName: "Witch.UI.Automation.RuntimeBattleAutomationService",
      members: [
        { kind: "method", name: "PlayCardAsync", isStatic: true, parameters: [] }
      ]
    }
  ];
  const normalized = String(query || "").toLocaleLowerCase();
  const filtered = services.filter(type => type.fullName.toLocaleLowerCase().includes(normalized) || type.fullName.split(".").pop().toLocaleLowerCase().includes(normalized));
  return filtered.length > 0 ? filtered : services;
}

bridge.listen(port, "127.0.0.1");
await once(bridge, "listening");

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}`,
    WITCH_JOURNEY_EVIDENCE_LOG: path.join(tempDir, "evidence.json")
  },
  stdio: ["pipe", "pipe", "inherit"]
});

const messages = [];
let output = Buffer.alloc(0);
child.stdout.setEncoding("binary");
child.stdout.on("data", data => {
  output = Buffer.concat([output, Buffer.from(data, "binary")]);
  while (true) {
    const headerEnd = output.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /content-length:\s*(\d+)/i.exec(output.subarray(0, headerEnd).toString("ascii"));
    if (!match) throw new Error("missing content-length");
    const length = Number(match[1]);
    if (output.subarray(headerEnd + 4).length < length) return;
    const bodyStart = headerEnd + 4;
    const body = output.subarray(bodyStart, bodyStart + length).toString("utf8");
    output = output.subarray(bodyStart + length);
    messages.push(JSON.parse(body));
  }
});

function send(id, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function waitForMessage(id) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    const message = messages.find(item => item.id === id);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for message ${id}`);
}

send(1, "initialize", {});
await waitForMessage(1);
send(2, "tools/call", { name: "witch_capabilities", arguments: {} });
send(3, "tools/call", { name: "witch_wait_bridge", arguments: { timeoutMs: 1000, pollMs: 50 } });
send(4, "tools/call", { name: "witch_verify_readiness", arguments: { preferKinds: ["run"], bridgeTimeoutMs: 1000, bridgePollMs: 50, screenshotPath: "readiness.png", screenshotTimeoutMs: 1000 } });
send(5, "tools/call", { name: "witch_game_snapshot", arguments: {} });
send(6, "tools/call", { name: "witch_state_summary", arguments: { preferKinds: ["run"] } });
send(7, "tools/call", { name: "witch_plan_next", arguments: { preferKinds: ["run"] } });
send(8, "tools/call", { name: "witch_execute_plan", arguments: { dryRun: true, preferKinds: ["run"] } });
await waitForMessage(8);
const performedAfterDryRun = performedActions;
send(9, "tools/call", { name: "witch_execute_plan", arguments: { dryRun: false, includePostSummary: false, preferKinds: ["run"] } });
await waitForMessage(9);
send(10, "tools/call", { name: "witch_find_targets", arguments: { query: "journey" } });
send(11, "tools/call", { name: "witch_find_targets", arguments: { query: "door" } });
send(12, "tools/call", { name: "witch_batch", arguments: {
  dryRun: true,
  steps: [
    { tool: "witch_wait_bridge", arguments: { timeoutMs: 1000, pollMs: 50 } },
    { tool: "witch_verify_readiness", arguments: { preferKinds: ["run"], includeScreenshot: false, bridgeTimeoutMs: 1000, bridgePollMs: 50 } },
    { tool: "witch_state_summary", arguments: { preferKinds: ["run"] } },
    { tool: "witch_find_targets", arguments: { query: "journey" } },
    { tool: "witch_execute_plan", arguments: { preferKinds: ["run"] } }
  ]
} });
send(13, "tools/call", { name: "witch_batch", arguments: {
  dryRun: false,
  steps: [
    { tool: "witch_execute_plan", arguments: { includePostSummary: false, preferKinds: ["run"] } }
  ]
} });
send(14, "tools/call", { name: "witch_perform_action_match", arguments: { label: "journey" } });
send(15, "tools/call", { name: "witch_ui_click_label", arguments: { label: "start journey" } });
send(16, "tools/call", { name: "witch_auto_step", arguments: { dryRun: true, preferKinds: ["run"] } });
send(17, "tools/call", { name: "witch_auto_drive", arguments: { maxSteps: 3, preferKinds: ["run"], stopOnKinds: ["done"], waitAfterMs: 0 } });
send(18, "tools/call", { name: "witch_screen_info", arguments: {} });
send(19, "tools/call", { name: "witch_screen_capture", arguments: { path: "test.png" } });
send(20, "tools/call", { name: "witch_screen_capture_wait", arguments: { path: "wait.png", timeoutMs: 1000 } });
send(21, "tools/call", { name: "witch_input_key", arguments: { key: "escape" } });
send(22, "tools/call", { name: "witch_input_text", arguments: { text: "abc" } });
send(23, "tools/call", { name: "witch_input_mouse", arguments: { action: "move", x: 10, y: 20 } });
send(24, "tools/call", { name: "witch_window_focus", arguments: {} });
send(25, "tools/call", { name: "witch_batch", arguments: {
  dryRun: true,
  stopOnError: false,
  steps: [
    { tool: "witch_window_focus", arguments: {} },
    { tool: "witch_input_key", arguments: { key: "enter" } },
    { tool: "witch_input_mouse", arguments: { action: "click", x: 100, y: 120 } },
    { tool: "witch_screen_capture_wait", arguments: { path: "dry-run.png" } }
  ]
} });
send(26, "tools/call", { name: "witch_takeover_step", arguments: {
  dryRun: true,
  preferKinds: ["run"],
  bridgeTimeoutMs: 1000,
  bridgePollMs: 50,
  screenshotPath: "takeover-dry.png"
} });
send(27, "tools/call", { name: "witch_takeover_step", arguments: {
  dryRun: false,
  includeScreenshot: false,
  includePostSummary: false,
  preferKinds: ["run"],
  bridgeTimeoutMs: 1000,
  bridgePollMs: 50
} });
send(28, "tools/call", { name: "witch_takeover_drive", arguments: {
  dryRun: true,
  maxSteps: 3,
  preferKinds: ["run"],
  bridgeTimeoutMs: 1000,
  bridgePollMs: 50,
  includeScreenshot: false
} });
send(29, "tools/call", { name: "witch_takeover_drive", arguments: {
  dryRun: false,
  maxSteps: 2,
  preferKinds: ["run"],
  bridgeTimeoutMs: 1000,
  bridgePollMs: 50,
  includeScreenshot: false,
  includePostSummary: false,
  waitAfterMs: 0
} });
send(30, "tools/call", { name: "witch_runtime_diagnostics", arguments: { includeLogTail: false } });
send(31, "tools/call", { name: "witch_runtime_inspect", arguments: { query: "RuntimeGameplayAutomationService", maxTypes: 5 } });
send(32, "tools/call", { name: "witch_runtime_invoke_static", arguments: { typeName: "Witch.UI.Automation.RuntimeGameplayAutomationService", methodName: "GetLegalActions", arguments: [] } });
send(33, "tools/call", { name: "witch_batch", arguments: {
  dryRun: true,
  steps: [
    { tool: "witch_runtime_inspect", arguments: { query: "Automation" } },
    { tool: "witch_runtime_objects", arguments: { query: "Camera" } },
    { tool: "witch_runtime_object_detail", arguments: { name: "MainCamera", componentType: "Camera" } },
    { tool: "witch_runtime_component_members", arguments: { name: "MainCamera", componentType: "Camera", memberQuery: "field" } },
    { tool: "witch_runtime_component_call", arguments: { name: "MainCamera", componentType: "Camera", methodName: "GetInstanceID" } },
    { tool: "witch_runtime_component_set", arguments: { name: "MainCamera", componentType: "Camera", memberName: "fieldOfView", value: 60 } },
    { tool: "witch_runtime_invoke_static", arguments: { typeName: "Witch.UI.Automation.RuntimeGameplayAutomationService", methodName: "GetLegalActions", arguments: [] } }
  ]
} });
send(34, "tools/call", { name: "witch_prepare_takeover", arguments: {
  launchIfNotRunning: false,
  bridgeTimeoutMs: 1000,
  bridgePollMs: 50,
  includeScreenshot: false
} });
send(35, "tools/call", { name: "witch_runtime_objects", arguments: { query: "Camera", componentType: "Camera", maxObjects: 5 } });
send(36, "tools/call", { name: "witch_runtime_object_detail", arguments: { instanceId: 77, componentType: "Camera" } });
send(37, "tools/call", { name: "witch_runtime_component_call", arguments: { instanceId: 77, componentType: "Camera", methodName: "GetInstanceID" } });
send(38, "tools/call", { name: "witch_runtime_component_members", arguments: { instanceId: 77, componentType: "Camera", memberQuery: "field" } });
send(39, "tools/call", { name: "witch_runtime_component_set", arguments: { instanceId: 77, componentType: "Camera", memberName: "fieldOfView", value: 60 } });
send(40, "tools/call", { name: "witch_takeover_audit", arguments: { bridgeTimeoutMs: 1000, bridgePollMs: 50, includeScreenshot: false } });
send(41, "tools/call", { name: "witch_watch_bridge_load", arguments: { timeoutMs: 1000, pollMs: 50, runAuditWhenReady: true, includeScreenshot: false } });
send(42, "tools/call", { name: "witch_restart_and_watch_bridge", arguments: { timeoutMs: 1000, pollMs: 50 } });
send(43, "tools/call", { name: "witch_auto_step", arguments: { dryRun: false, label: "open map", denyKinds: ["navigation"] } });
send(44, "tools/call", { name: "witch_no_mouse_audit", arguments: { includeCurrentState: true, includePolicyTests: true } });
send(45, "tools/call", { name: "witch_control_map", arguments: { includeHidden: false, onlyInteractive: true } });
send(46, "tools/call", { name: "witch_no_mouse_coverage", arguments: { includeCurrentState: true, includePolicyTests: true } });
send(47, "tools/call", { name: "witch_no_mouse_record_evidence", arguments: { reset: true, note: "orchestration-test" } });
send(48, "tools/call", { name: "witch_no_mouse_completion_audit", arguments: { includeCurrentState: true, includePolicyTests: true } });
send(49, "tools/call", { name: "witch_execute_operation", arguments: { family: "battle", action: "play_card_target", dryRun: true } });
send(50, "tools/call", { name: "witch_no_mouse_evidence_plan", arguments: { includeCurrentState: true, includePolicyTests: true } });

for (let id = 2; id <= 50; id++) {
  await waitForMessage(id);
}
child.kill();
await once(child, "exit");
bridge.close();
await fs.rm(tempDir, { recursive: true, force: true });

function textResult(id) {
  const message = messages.find(item => item.id === id);
  if (!message?.result?.content?.[0]?.text) {
    throw new Error(`missing result ${id}: ${JSON.stringify(messages, null, 2)}`);
  }
  return JSON.parse(message.result.content[0].text);
}

const capabilities = textResult(2);
const bridgeWait = textResult(3);
const readiness = textResult(4);
const snapshot = textResult(5);
const summary = textResult(6);
const plan = textResult(7);
const executeDryRun = textResult(8);
const executeReal = textResult(9);
const foundJourney = textResult(10);
const foundDoor = textResult(11);
const batchDryRun = textResult(12);
const batchReal = textResult(13);
const matchedAction = textResult(14);
const click = textResult(15);
const autoStep = textResult(16);
const autoDrive = textResult(17);
const screenInfo = textResult(18);
const screenCapture = textResult(19);
const screenCaptureWait = textResult(20);
const inputKey = textResult(21);
const inputText = textResult(22);
const inputMouse = textResult(23);
const windowFocus = textResult(24);
const inputBatch = textResult(25);
const takeoverDryRun = textResult(26);
const takeoverReal = textResult(27);
const takeoverDriveDryRun = textResult(28);
const takeoverDriveReal = textResult(29);
const runtimeDiagnostics = textResult(30);
const runtimeInspect = textResult(31);
const runtimeInvoke = textResult(32);
const runtimeBatch = textResult(33);
const prepareTakeover = textResult(34);
const runtimeObjects = textResult(35);
const runtimeObjectDetail = textResult(36);
const runtimeComponentCall = textResult(37);
const runtimeComponentMembers = textResult(38);
const runtimeComponentSet = textResult(39);
const takeoverAudit = textResult(40);
const bridgeLoadWatch = textResult(41);
const restartAndWatchDenied = textResult(42);
const policyDeniedAutoStep = textResult(43);
const noMouseAudit = textResult(44);
const controlMap = textResult(45);
const noMouseCoverage = textResult(46);
const noMouseEvidence = textResult(47);
const noMouseCompletionAudit = textResult(48);
const executeOperation = textResult(49);
const noMouseEvidencePlan = textResult(50);

if (!capabilities.ok || capabilities.tools.length < 53 || capabilities.noMouseDefault !== true || capabilities.noMouseMode?.enabledByDefault !== true) {
  throw new Error("capabilities did not describe the expanded tool set");
}
if (!runtimeDiagnostics.ok || runtimeDiagnostics.bridgeStatus?.data?.bridge !== "fake" || !Array.isArray(runtimeDiagnostics.modFiles) || runtimeDiagnostics.bridgeArtifactFreshness?.ok !== true) {
  throw new Error(`bad runtime diagnostics ${JSON.stringify(runtimeDiagnostics, null, 2)}`);
}
if (!runtimeInspect.ok || runtimeInspect.data?.types?.[0]?.fullName !== "Witch.UI.Automation.RuntimeGameplayAutomationService") {
  throw new Error(`bad runtime inspect ${JSON.stringify(runtimeInspect, null, 2)}`);
}
if (!runtimeInvoke.ok || runtimeInvoke.data?.methodName !== "GetLegalActions" || runtimeInvoke.data?.result?.invoked !== true) {
  throw new Error(`bad runtime invoke ${JSON.stringify(runtimeInvoke, null, 2)}`);
}
if (!runtimeBatch.ok || runtimeBatch.results?.[0]?.result?.data?.types?.length < 1 || runtimeBatch.results?.[1]?.result?.data?.objects?.[0]?.name !== "MainCamera" || runtimeBatch.results?.[2]?.result?.data?.components?.[0]?.name !== "Camera" || runtimeBatch.results?.[3]?.result?.data?.components?.[0]?.members?.[0]?.name !== "fieldOfView" || runtimeBatch.results?.[4]?.result?.data?.method?.name !== "GetInstanceID" || runtimeBatch.results?.[5]?.result?.data?.member?.name !== "fieldOfView" || runtimeBatch.results?.[6]?.result?.skipped !== true) {
  throw new Error(`bad runtime batch ${JSON.stringify(runtimeBatch, null, 2)}`);
}
if (!prepareTakeover.ok || prepareTakeover.reason !== "ready" || !prepareTakeover.readiness?.ok) {
  throw new Error(`bad prepare takeover ${JSON.stringify(prepareTakeover, null, 2)}`);
}
if (!runtimeObjects.ok || runtimeObjects.data?.objects?.[0]?.components?.[0]?.name !== "Camera") {
  throw new Error(`bad runtime objects ${JSON.stringify(runtimeObjects, null, 2)}`);
}
if (!runtimeObjectDetail.ok || runtimeObjectDetail.data?.components?.[0]?.members?.[0]?.name !== "fieldOfView") {
  throw new Error(`bad runtime object detail ${JSON.stringify(runtimeObjectDetail, null, 2)}`);
}
if (!runtimeComponentCall.ok || runtimeComponentCall.data?.dryRun !== true || runtimeComponentCall.data?.method?.name !== "GetInstanceID") {
  throw new Error(`bad runtime component call ${JSON.stringify(runtimeComponentCall, null, 2)}`);
}
if (!runtimeComponentMembers.ok || runtimeComponentMembers.data?.components?.[0]?.members?.[0]?.name !== "fieldOfView") {
  throw new Error(`bad runtime component members ${JSON.stringify(runtimeComponentMembers, null, 2)}`);
}
if (!runtimeComponentSet.ok || runtimeComponentSet.data?.dryRun !== true || runtimeComponentSet.data?.member?.name !== "fieldOfView") {
  throw new Error(`bad runtime component set ${JSON.stringify(runtimeComponentSet, null, 2)}`);
}
if (!takeoverAudit.ok || takeoverAudit.requirements?.some(item => !item.ok) || takeoverAudit.artifacts?.lowLevelRuntimeChecks?.results?.[5]?.result?.data?.member?.name !== "fieldOfView") {
  throw new Error(`bad takeover audit ${JSON.stringify(takeoverAudit, null, 2)}`);
}
if (!takeoverAudit.requirements?.some(item => item.name === "local_os_fallback_control" && item.ok)) {
  throw new Error(`takeover audit missing local OS fallback control ${JSON.stringify(takeoverAudit, null, 2)}`);
}
if (!bridgeLoadWatch.ok || bridgeLoadWatch.timedOut !== false || bridgeLoadWatch.takeoverAudit?.ok !== true || !bridgeLoadWatch.events?.some(item => item.type === "bridge_status" && item.ok === true)) {
  throw new Error(`bad bridge load watch ${JSON.stringify(bridgeLoadWatch, null, 2)}`);
}
if (restartAndWatchDenied?.reason !== "restart_confirmation_required" || restartAndWatchDenied?.nextStep !== "confirm_restart") {
  throw new Error(`restart-and-watch did not require confirmation ${JSON.stringify(restartAndWatchDenied, null, 2)}`);
}
if (policyDeniedAutoStep?.ok !== false || policyDeniedAutoStep?.reason !== "action_policy_denied" || !policyDeniedAutoStep?.policy?.deniedBy?.includes("denyKinds")) {
  throw new Error(`auto step did not enforce action policy ${JSON.stringify(policyDeniedAutoStep, null, 2)}`);
}
if (!noMouseAudit.ok || noMouseAudit.policyTests?.ok !== true || noMouseAudit.checks?.some(item => !item.ok)) {
  throw new Error(`bad no-mouse audit ${JSON.stringify(noMouseAudit, null, 2)}`);
}
if (!controlMap.ok || controlMap.noMouseDefault !== true || controlMap.operationCount < 5 || controlMap.byFamily?.legal_action < 1 || controlMap.byFamily?.ui < 1 || controlMap.byFamily?.scene < 1 || controlMap.byFamily?.battle < 1 || controlMap.operations?.some(item => item.noMouse !== true || !item.call?.tool)) {
  throw new Error(`bad control map ${JSON.stringify(controlMap, null, 2)}`);
}
if (!noMouseCoverage.ok || noMouseCoverage.checks?.some(item => !item.ok) || noMouseCoverage.families?.some(item => !item.runtime?.ok)) {
  throw new Error(`bad no-mouse coverage ${JSON.stringify(noMouseCoverage, null, 2)}`);
}
if (!noMouseEvidence.ok || noMouseEvidence.summary?.sampleCount < 1 || noMouseEvidence.summary?.families?.battle?.observed !== true) {
  throw new Error(`bad no-mouse evidence record ${JSON.stringify(noMouseEvidence, null, 2)}`);
}
if (!noMouseCompletionAudit.complete || noMouseCompletionAudit.requirements?.some(item => item.status !== "proved")) {
  throw new Error(`bad no-mouse completion audit ${JSON.stringify(noMouseCompletionAudit, null, 2)}`);
}
if (!executeOperation.ok || executeOperation.dryRun !== true || executeOperation.selected?.family !== "battle" || executeOperation.selected?.action !== "play_card_target" || executeOperation.plannedCall?.tool !== "witch_play_card" || executeOperation.result?.skipped !== true) {
  throw new Error(`bad execute operation ${JSON.stringify(executeOperation, null, 2)}`);
}
if (!noMouseEvidencePlan.ok || noMouseEvidencePlan.complete !== true || noMouseEvidencePlan.readyProbeCount !== 0 || noMouseEvidencePlan.completionAuditCall?.tool !== "witch_no_mouse_completion_audit") {
  throw new Error(`bad no-mouse evidence plan ${JSON.stringify(noMouseEvidencePlan, null, 2)}`);
}
if (!bridgeWait.ok || bridgeWait.status?.data?.bridge !== "fake") {
  throw new Error(`bad bridge wait ${JSON.stringify(bridgeWait, null, 2)}`);
}
if (!readiness.ok || readiness.checks?.some(check => !check.ok)) {
  throw new Error(`bad readiness ${JSON.stringify(readiness, null, 2)}`);
}
if (!snapshot.ok || !snapshot.ui?.ok || !snapshot.scene?.ok || !snapshot.legalActions?.ok) {
  throw new Error(`bad snapshot ${JSON.stringify(snapshot, null, 2)}`);
}
if (!summary.ok || summary.ui?.clickableNodes?.[0]?.label !== "start journey" || summary.suggestedNextAction?.kind !== "run" || summary.scene?.objects?.[0]?.hasCollider2D !== true) {
  throw new Error(`bad summary ${JSON.stringify(summary, null, 2)}`);
}
if (!plan.ok || plan.strategy !== "legal_action" || plan.recommendedCall?.tool !== "witch_perform_action_match" || plan.recommendedCall?.arguments?.actionId !== "start-run") {
  throw new Error(`bad plan ${JSON.stringify(plan, null, 2)}`);
}
if (!executeDryRun?.dryRun || executeDryRun?.result?.result?.skipped !== true || performedAfterDryRun !== 0) {
  throw new Error(`bad execute dry run ${JSON.stringify({ executeDryRun, performedAfterDryRun }, null, 2)}`);
}
if (executeReal?.dryRun !== false || executeReal?.result?.result?.data?.ActionId !== "start-run") {
  throw new Error(`bad execute real ${JSON.stringify(executeReal, null, 2)}`);
}
if (!foundJourney.ok || !foundJourney.results.some(item => item.type === "ui_node" || item.type === "legal_action")) {
  throw new Error(`bad find journey ${JSON.stringify(foundJourney, null, 2)}`);
}
if (!foundDoor.ok || foundDoor.results?.[0]?.type !== "scene_object" || foundDoor.results[0]?.nextCall?.tool !== "witch_scene_interact") {
  throw new Error(`bad find door ${JSON.stringify(foundDoor, null, 2)}`);
}
if (!batchDryRun.ok || batchDryRun.results?.length !== 5 || batchDryRun.results[4]?.result?.dryRun !== true) {
  throw new Error(`bad batch dry run ${JSON.stringify(batchDryRun, null, 2)}`);
}
if (!batchReal.ok || batchReal.dryRun !== false || batchReal.results?.[0]?.result?.dryRun !== false) {
  throw new Error(`bad batch real ${JSON.stringify(batchReal, null, 2)}`);
}
if (matchedAction?.selected?.Id !== "start-run" || matchedAction?.result?.data?.ActionId !== "start-run") {
  throw new Error(`bad action match ${JSON.stringify(matchedAction, null, 2)}`);
}
if (click?.data?.Selector?.label !== "start journey") {
  throw new Error(`bad click wrapper ${JSON.stringify(click, null, 2)}`);
}
if (!autoStep?.dryRun || autoStep?.selected?.Kind !== "run" || autoStep?.result?.skipped !== true) {
  throw new Error(`bad auto step ${JSON.stringify(autoStep, null, 2)}`);
}
if (!autoDrive?.ok || autoDrive?.steps?.length !== 3 || autoDrive.steps[0]?.selected?.Kind !== "run") {
  throw new Error(`bad auto drive ${JSON.stringify(autoDrive, null, 2)}`);
}
if (screenInfo?.data?.width !== 1280 || screenInfo?.data?.activeWindow !== 12345) {
  throw new Error(`bad screen info ${JSON.stringify(screenInfo, null, 2)}`);
}
if (screenCapture?.data?.fullPath !== capturePath) {
  throw new Error(`bad screen capture ${JSON.stringify(screenCapture, null, 2)}`);
}
if (!screenCaptureWait?.ok || screenCaptureWait?.fullPath !== capturePath || screenCaptureWait?.sizeBytes < 8) {
  throw new Error(`bad screen capture wait ${JSON.stringify(screenCaptureWait, null, 2)}`);
}
if (inputKey?.data?.command !== "input.key" || inputKey?.data?.params?.key !== "escape") {
  throw new Error(`bad input key ${JSON.stringify(inputKey, null, 2)}`);
}
if (inputText?.data?.command !== "input.text" || inputText?.data?.params?.text !== "abc") {
  throw new Error(`bad input text ${JSON.stringify(inputText, null, 2)}`);
}
if (inputMouse?.ok !== false || inputMouse?.reason !== "mouse_forbidden" || inputMouse?.command !== "input.mouse" || inputMouse?.noMouse !== true) {
  throw new Error(`bad input mouse ${JSON.stringify(inputMouse, null, 2)}`);
}
if (windowFocus?.data?.isForeground !== true) {
  throw new Error(`bad window focus ${JSON.stringify(windowFocus, null, 2)}`);
}
if (inputBatch.ok !== false || inputBatch.results?.[0]?.result?.plannedTool !== "witch_window_focus" || inputBatch.results?.[1]?.result?.skipped !== true || inputBatch.results?.[2]?.result?.reason !== "mouse_forbidden" || inputBatch.results?.[3]?.result?.plannedTool !== "witch_screen_capture_wait") {
  throw new Error(`bad input batch dry run ${JSON.stringify(inputBatch, null, 2)}`);
}
if (!takeoverDryRun.ok || takeoverDryRun.dryRun !== true || takeoverDryRun.steps?.screenshot?.plannedTool !== "witch_screen_capture_wait" || takeoverDryRun.steps?.execution?.result?.skipped !== true) {
  throw new Error(`bad takeover dry run ${JSON.stringify(takeoverDryRun, null, 2)}`);
}
if (!takeoverReal.ok || takeoverReal.dryRun !== false || takeoverReal.steps?.execution?.result?.data?.ActionId !== takeoverReal.steps?.plan?.recommendedCall?.arguments?.actionId) {
  throw new Error(`bad takeover real ${JSON.stringify(takeoverReal, null, 2)}`);
}
if (!takeoverDriveDryRun.ok || takeoverDriveDryRun.dryRun !== true || takeoverDriveDryRun.steps?.length !== 1 || takeoverDriveDryRun.reason !== "dry_run") {
  throw new Error(`bad takeover drive dry run ${JSON.stringify(takeoverDriveDryRun, null, 2)}`);
}
if (!takeoverDriveReal.ok || takeoverDriveReal.dryRun !== false || takeoverDriveReal.steps?.length !== 2 || takeoverDriveReal.reason !== "max_steps") {
  throw new Error(`bad takeover drive real ${JSON.stringify(takeoverDriveReal, null, 2)}`);
}

console.log("ok: orchestration tools");
