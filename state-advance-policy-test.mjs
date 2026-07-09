import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19173;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "witch-state-advance-test-"));

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const result = bridgeResult(payload.command, payload.params || {});
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
});

function bridgeResult(command) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "fake", version: "test" } };
    case "ui.snapshot":
      return {
        ok: true,
        data: {
          TotalNodes: 5,
          Windows: [
            { WindowName: "EventUI", NodeId: "event-window", Visible: true, ActiveInHierarchy: true },
            { WindowName: "TopBarUI", NodeId: "topbar-window", Visible: true, ActiveInHierarchy: true }
          ],
          Nodes: [
            {
              NodeId: "EventUI|Canvas/EventUI/Windows/Map0/Content/Selector/option1|101",
              InstanceId: 101,
              Label: "take the north road",
              WindowName: "EventUI",
              TransformPath: "Canvas/EventUI/Windows/Map0/Content/Selector/option1",
              Clickable: true,
              Visible: true,
              ActiveInHierarchy: true,
              SupportedActions: ["click", "submit", "hover"],
              ScreenRect: { X: 10, Y: 10, Width: 200, Height: 40 }
            },
            {
              NodeId: "EventUI|Canvas/EventUI/Windows/Map0/Content/Selector/option2|102",
              InstanceId: 102,
              Label: "take the south road",
              WindowName: "EventUI",
              TransformPath: "Canvas/EventUI/Windows/Map0/Content/Selector/option2",
              Clickable: true,
              Visible: true,
              ActiveInHierarchy: true,
              SupportedActions: ["click", "submit", "hover"],
              ScreenRect: { X: 10, Y: 60, Width: 200, Height: 40 }
            },
            {
              NodeId: "EventUI|Canvas/EventUI/Windows/Map0/Content/Description/Main/Scroll View|103",
              InstanceId: 103,
              Label: "story description text",
              WindowName: "EventUI",
              TransformPath: "Canvas/EventUI/Windows/Map0/Content/Description/Main/Scroll View",
              Clickable: true,
              Visible: true,
              ActiveInHierarchy: true,
              SupportedActions: ["click", "scroll", "drag"],
              ScreenRect: { X: 10, Y: 110, Width: 400, Height: 220 }
            },
            {
              NodeId: "TopBarUI|Canvas/TopBarUI/Content/Buttons/ExitGame|201",
              InstanceId: 201,
              Label: "Button",
              WindowName: "TopBarUI",
              TransformPath: "Canvas/TopBarUI/Content/Buttons/ExitGame",
              Clickable: true,
              Visible: true,
              ActiveInHierarchy: true,
              SupportedActions: ["click", "submit"],
              ScreenRect: { X: 500, Y: 10, Width: 40, Height: 40 }
            },
            {
              NodeId: "TopBarUI|Canvas/TopBarUI/Content/PlayerStatus/Relic/Scroll Area/List/Null|202",
              InstanceId: 202,
              Label: "确认，就它了！",
              WindowName: "TopBarUI",
              TransformPath: "Canvas/TopBarUI/Content/PlayerStatus/Relic/Scroll Area/List/Null",
              Clickable: true,
              Visible: true,
              ActiveInHierarchy: true,
              SupportedActions: ["click", "submit", "hover"],
              ScreenRect: { X: 550, Y: 10, Width: 40, Height: 40 }
            }
          ]
        }
      };
    case "scene.snapshot":
      return { ok: true, data: { SceneName: "game", Objects: [] } };
    case "game.legal_actions":
      return { ok: true, data: { Actions: [] } };
    case "battle.snapshot":
      return { ok: true, data: { inBattle: false, cards: [], targets: [], supportedActions: ["play_card"] } };
    case "runtime.inspect":
      return {
        ok: true,
        data: {
          types: [
            serviceType("Witch.UI.Automation.RuntimeGameplayAutomationService", ["GetLegalActions", "PerformActionAsync"]),
            serviceType("Witch.UI.Automation.RuntimeUiAutomationService", ["CaptureSnapshot", "EvaluateWaitCondition", "InteractAsync"]),
            serviceType("Witch.UI.Automation.RuntimeSceneAutomationService", ["CaptureSnapshot", "Raycast", "InteractAsync"]),
            serviceType("Witch.UI.Automation.RuntimeBattleAutomationService", ["PlayCardAsync"])
          ]
        }
      };
    default:
      return { ok: true, data: { command } };
  }
}

function serviceType(fullName, methods) {
  return {
    assembly: "Witch",
    fullName,
    isPublic: true,
    isStatic: true,
    methodCount: methods.length,
    members: methods.map(name => ({ kind: "method", name, isStatic: true, parameters: [] }))
  };
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

async function waitForMessage(id, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(item => item.id === id);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for message ${id}`);
}

send(1, "initialize", {});
await waitForMessage(1);
send(2, "tools/call", { name: "witch_no_mouse_evidence_plan", arguments: { includePolicyTests: true } });
send(3, "tools/call", { name: "witch_no_mouse_state_advance_drive", arguments: { dryRun: true, maxSteps: 1, maxProbesPerStep: 0, waitAfterAdvanceMs: 0, includePlan: false, allowPaths: ["option2"] } });
send(4, "tools/call", { name: "witch_no_mouse_state_advance_drive", arguments: { dryRun: true, maxSteps: 1, maxProbesPerStep: 0, waitAfterAdvanceMs: 0, includePlan: false, denyPaths: ["option1", "option2"] } });
send(5, "tools/call", { name: "witch_no_mouse_restart_advance_audit", arguments: { includePreview: true, includePlan: false, allowPaths: ["option2"] } });

await waitForMessage(2);
await waitForMessage(3);
await waitForMessage(4);
await waitForMessage(5);
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

const plan = textResult(2);
const allowOption2 = textResult(3);
const denyOptions = textResult(4);
const restartAdvancePreview = textResult(5);
const candidateIds = (plan.stateAdvanceCandidates || []).map(item => item.operation?.id || "");

if (candidateIds.length !== 2 || candidateIds.some(id => !id.includes(":click")) || candidateIds.some(id => /submit|hover|scroll|drag|TopBarUI|Description|ExitGame/i.test(id))) {
  throw new Error(`bad state advance candidates ${JSON.stringify(plan.stateAdvanceCandidates, null, 2)}`);
}
if (allowOption2.reason !== "dry_run_planned" || !allowOption2.steps?.[0]?.selectedCandidate?.operation?.id?.includes("option2")) {
  throw new Error(`allowPaths did not select option2 ${JSON.stringify(allowOption2, null, 2)}`);
}
if (denyOptions.reason !== "state_advance_policy_filtered" || denyOptions.blockedCandidates?.length !== 2 || denyOptions.steps?.[0]?.selectedCandidate != null) {
  throw new Error(`denyPaths did not block option candidates ${JSON.stringify(denyOptions, null, 2)}`);
}
if (restartAdvancePreview.reason !== "restart_confirmation_required" || restartAdvancePreview.preview?.stateAdvanceCandidates?.length !== 1 || !restartAdvancePreview.preview.stateAdvanceCandidates[0].operation?.id?.includes("option2") || restartAdvancePreview.preview?.blockedStateAdvanceCandidates?.length !== 1 || restartAdvancePreview.preview?.plannedCalls?.restart?.arguments?.allowPaths?.[0] !== "option2") {
  throw new Error(`restart advance preview did not preserve state policy ${JSON.stringify(restartAdvancePreview, null, 2)}`);
}

console.log("ok: state advance policy");
