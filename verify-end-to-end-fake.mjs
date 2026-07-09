import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19173;
let performedActions = 0;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "witch-e2e-fake-"));
const capturePath = path.join(tempDir, "capture.png");
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method === "GET" && request.url === "/health") {
      respond(response, { ok: true, bridge: "fake", version: "test" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/command") {
      respond(response, { ok: false, error: "unexpected route" }, 404);
      return;
    }

    const payload = JSON.parse(body || "{}");
    respond(response, commandResult(payload.command, payload.params || {}));
  });
});

bridge.listen(port, "127.0.0.1");
await once(bridge, "listening");

try {
  const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", "verify-end-to-end.ps1"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}`,
      WITCH_E2E_ALLOW_FAKE_NO_PROCESS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdoutPromise = streamText(child.stdout);
  const stderrPromise = streamText(child.stderr);
  const [exitCode] = await once(child, "exit");
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  if (exitCode !== 0) {
    throw new Error(`verify-end-to-end.ps1 failed with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  if (!stdout.includes("ok: bridge and MCP tool path responded")) {
    throw new Error(`verify-end-to-end.ps1 did not print success marker\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  console.log("ok: fake bridge end-to-end assertions");
} finally {
  bridge.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}

function respond(response, data, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function commandResult(command, params) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "fake", version: "test" } };
    case "ui.snapshot":
      return {
        ok: true,
        data: {
          TotalNodes: 2,
          LayoutSignature: "layout-test",
          Windows: [{ WindowName: "MainMenu", NodeId: "window-main", Visible: true, ActiveInHierarchy: true }],
          Nodes: [
            { NodeId: "start", Label: "start journey", WindowName: "MainMenu", Clickable: true, SupportedActions: ["click"] },
            { NodeId: "title", Label: "title", WindowName: "MainMenu", Clickable: false }
          ]
        }
      };
    case "ui.interact":
      return { ok: true, data: { Success: true, Selector: params.selector } };
    case "ui.wait":
      return { ok: true, data: { Satisfied: true } };
    case "scene.snapshot":
      return {
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
              SupportedActions: ["click"],
              ScreenPoint: { X: 10, Y: 20 },
              ScreenRect: { X: 1, Y: 2, Width: 30, Height: 40 }
            }
          ]
        }
      };
    case "scene.interact":
    case "scene.raycast":
      return { ok: true, data: { Success: true } };
    case "screen.info":
      return { ok: true, data: { width: 1280, height: 720, activeWindow: 12345 } };
    case "screen.capture":
      fsSync.writeFileSync(capturePath, pngHeader);
      return { ok: true, data: { fullPath: capturePath, isAsync: true, width: 1280, height: 720 } };
    case "window.focus":
      return { ok: true, data: { focused: true, isForeground: true, requestedWindow: 12345 } };
    case "runtime.inspect":
      return { ok: true, data: { types: fakeRuntimeTypes(params.query || "") } };
    case "runtime.objects":
      return { ok: true, data: { objects: [{ name: "MainCamera", instanceId: 77, components: [{ type: "UnityEngine.Camera", name: "Camera" }] }] } };
    case "runtime.object_detail":
      return { ok: true, data: { found: true, components: [{ type: "UnityEngine.Camera", name: "Camera", members: [{ kind: "property", name: "fieldOfView", value: 60 }] }] } };
    case "runtime.component_members":
      return { ok: true, data: { found: true, components: [{ type: "UnityEngine.Camera", name: "Camera", members: [{ name: "fieldOfView", writable: true }] }] } };
    case "runtime.component_call":
      return { ok: true, data: { found: true, dryRun: params.dryRun !== false, method: { name: params.methodName } } };
    case "runtime.component_set":
      return { ok: true, data: { found: true, dryRun: params.dryRun !== false, member: { name: params.memberName }, requestedValue: params.value } };
    case "game.legal_actions": {
      const running = performedActions < 3;
      return {
        ok: true,
        data: {
          Phase: running ? "menu" : "done",
          Actions: [
            { Id: "open-map", Kind: "navigation", Label: "open map" },
            { Id: running ? "start-run" : "finish", Kind: running ? "run" : "done", Label: running ? "start journey" : "done" }
          ]
        }
      };
    }
    case "game.perform_action":
      performedActions += 1;
      return { ok: true, data: { Success: true, ActionId: params.actionId } };
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
}

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

async function streamText(stream) {
  const chunks = [];
  stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
  await once(stream, "end");
  return Buffer.concat(chunks).toString("utf8");
}
