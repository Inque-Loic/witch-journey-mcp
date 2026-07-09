import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19180;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "witch-runtime-fallback-completion-test-"));

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method === "GET" && request.url === "/health") {
      respond(response, { ok: true, bridge: "CodexMcpBridge", version: "0.9.0-old" });
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

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    WITCH_JOURNEY_GAME_ROOT: tempRoot,
    WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}`,
    WITCH_JOURNEY_EVIDENCE_LOG: path.join(tempRoot, "evidence.json")
  },
  stdio: ["pipe", "pipe", "inherit"]
});

try {
  const messages = collectMcpMessages(child);
  send(child, 1, "initialize", {});
  await waitForMessage(messages, 1);
  send(child, 2, "tools/call", {
    name: "witch_no_mouse_completion_audit",
    arguments: {
      includeCurrentState: true,
      includePolicyTests: true,
      includeEvidenceLog: false
    }
  });
  await waitForMessage(messages, 2);

  const audit = textResult(messages, 2);
  const missingNames = new Set((audit.missing || []).map(item => item.name));
  const dataBridgeRequirement = (audit.requirements || []).find(item => item.name === "updated_data_bridge_loaded_or_ready");
  const nativeBattleRequirement = (audit.requirements || []).find(item => item.name === "native_battle_snapshot_active");

  if (audit.complete !== false) {
    throw new Error(`fallback audit should still be incomplete without live samples ${JSON.stringify(audit, null, 2)}`);
  }
  if (missingNames.has("updated_data_bridge_loaded_or_ready") || missingNames.has("native_battle_snapshot_active")) {
    throw new Error(`runtime fallback should satisfy bridge readiness requirements ${JSON.stringify(audit.missing, null, 2)}`);
  }
  if (dataBridgeRequirement?.evidence?.runtimeFallbackReadiness?.ok !== true) {
    throw new Error(`data bridge requirement did not record runtime fallback readiness ${JSON.stringify(dataBridgeRequirement, null, 2)}`);
  }
  if (nativeBattleRequirement?.evidence?.runtimeFallbackReadiness?.battleObservationOk !== true) {
    throw new Error(`native battle requirement did not record runtime battle observation fallback ${JSON.stringify(nativeBattleRequirement, null, 2)}`);
  }
  if (!missingNames.has("legal_action_live_sample_observed") || !missingNames.has("scene_live_sample_observed") || !missingNames.has("battle_live_sample_observed")) {
    throw new Error(`fallback audit should keep live-sample requirements strict ${JSON.stringify(audit.missing, null, 2)}`);
  }
} finally {
  child.kill();
  await once(child, "exit").catch(() => {});
  bridge.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("ok: runtime fallback completion audit");

function commandResult(command, params) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "CodexMcpBridge", version: "0.9.0-old" } };
    case "runtime.inspect":
      return { ok: true, data: { types: fakeRuntimeTypes() } };
    case "runtime.invoke_static":
      return runtimeStaticResult(params || {});
    case "runtime.objects":
      return { ok: true, data: { objects: [] } };
    case "ui.snapshot":
    case "scene.snapshot":
    case "game.legal_actions":
    case "battle.snapshot":
      return { ok: false, error: `System.InvalidOperationException: Unknown command: ${command}` };
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
}

function runtimeStaticResult(params) {
  const base = {
    typeName: params.typeName,
    methodName: params.methodName
  };
  if (params.typeName === "Witch.UI.Automation.RuntimeUiAutomationService" && params.methodName === "CaptureSnapshot") {
    return {
      ok: true,
      data: {
        ...base,
        result: {
          TotalNodes: 1,
          Windows: [{ WindowName: "MainMenu", NodeId: "window-main", Visible: true, ActiveInHierarchy: true }],
          Nodes: [{ NodeId: "start", Label: "Start", WindowName: "MainMenu", Clickable: true, SupportedActions: ["click"] }]
        }
      }
    };
  }
  if (params.typeName === "Witch.UI.Automation.RuntimeSceneAutomationService" && params.methodName === "CaptureSnapshot") {
    return {
      ok: true,
      data: {
        ...base,
        result: {
          SceneName: "MainScene",
          TotalObjects: 0,
          Objects: []
        }
      }
    };
  }
  if (params.typeName === "Witch.UI.Automation.RuntimeGameplayAutomationService" && params.methodName === "GetLegalActions") {
    return {
      ok: true,
      data: {
        ...base,
        result: {
          Phase: "menu",
          Actions: []
        }
      }
    };
  }
  return { ok: false, error: `unexpected runtime call ${params.typeName}.${params.methodName}` };
}

function fakeRuntimeTypes() {
  return [
    serviceType("Witch.UI.Automation.RuntimeGameplayAutomationService", ["GetLegalActions", "PerformActionAsync"]),
    serviceType("Witch.UI.Automation.RuntimeUiAutomationService", ["CaptureSnapshot", "EvaluateWaitCondition", "InteractAsync"]),
    serviceType("Witch.UI.Automation.RuntimeSceneAutomationService", ["CaptureSnapshot", "Raycast", "InteractAsync"]),
    serviceType("Witch.UI.Automation.RuntimeBattleAutomationService", ["PlayCardAsync"])
  ];
}

function serviceType(fullName, methods) {
  return {
    assembly: "Witch",
    fullName,
    members: methods.map(name => ({ kind: "method", name, isStatic: true, parameters: [] }))
  };
}

function respond(response, data, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function collectMcpMessages(processHandle) {
  const messages = [];
  let output = Buffer.alloc(0);
  processHandle.stdout.setEncoding("binary");
  processHandle.stdout.on("data", data => {
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
  return messages;
}

function send(processHandle, id, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  processHandle.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function waitForMessage(messages, id, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(item => item.id === id);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for message ${id}`);
}

function textResult(messages, id) {
  const message = messages.find(item => item.id === id);
  if (!message?.result?.content?.[0]?.text) {
    throw new Error(`missing result ${id}: ${JSON.stringify(messages, null, 2)}`);
  }
  return JSON.parse(message.result.content[0].text);
}
