import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19174;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "witch-no-mouse-guidance-test-"));

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method !== "POST" || request.url !== "/command") {
      respond(response, { ok: false, error: "unexpected route" }, 404);
      return;
    }
    const payload = JSON.parse(body || "{}");
    respond(response, commandResult(payload.command));
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
    name: "witch_no_mouse_evidence_plan",
    arguments: {
      includeCurrentState: true,
      includePolicyTests: true
    }
  });
  send(child, 3, "tools/call", {
    name: "witch_no_mouse_completion_audit",
    arguments: {
      includeCurrentState: true,
      includePolicyTests: true
    }
  });
  await waitForMessage(messages, 2);
  await waitForMessage(messages, 3);

  const plan = textResult(messages, 2);
  const audit = textResult(messages, 3);
  const bridgeStep = (plan.requirementSteps || []).find(item => item.name === "updated_data_bridge_loaded_or_ready");
  const nativeBattleStep = (plan.requirementSteps || []).find(item => item.name === "native_battle_snapshot_active");
  const bridgeMissing = (audit.missing || []).find(item => item.name === "updated_data_bridge_loaded_or_ready");

  if (plan.complete !== false || !bridgeStep || !nativeBattleStep) {
    throw new Error(`expected incomplete plan with bridge requirement steps ${JSON.stringify(plan, null, 2)}`);
  }
  if (!String(bridgeStep.scriptCommand || "").includes("-WaitForDllUnlock -WaitForBridgeAfterSync")) {
    throw new Error(`bridge step did not include manual proof script command ${JSON.stringify(bridgeStep, null, 2)}`);
  }
  if (bridgeStep.safeManualCall?.tool !== "witch_sync_bridge_artifacts" || bridgeStep.safeManualCall?.arguments?.waitForUnlock !== true) {
    throw new Error(`bridge step did not include safe manual MCP call ${JSON.stringify(bridgeStep, null, 2)}`);
  }
  if (bridgeStep.safeManualCall?.followUp?.tool !== "witch_watch_bridge_load") {
    throw new Error(`bridge step did not include bridge watch follow-up ${JSON.stringify(bridgeStep, null, 2)}`);
  }
  if (!String(bridgeMissing?.nextAction || "").includes("手动关闭游戏释放 DLL")) {
    throw new Error(`completion audit did not include actionable manual close guidance ${JSON.stringify(audit.missing, null, 2)}`);
  }
} finally {
  child.kill();
  await once(child, "exit").catch(() => {});
  bridge.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("ok: no-mouse manual bridge guidance");

function respond(response, data, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function commandResult(command) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "CodexMcpBridge", version: "0.9.0" } };
    case "runtime.inspect":
      return { ok: true, data: { types: fakeRuntimeTypes() } };
    case "ui.snapshot":
      return {
        ok: true,
        data: {
          TotalNodes: 1,
          Windows: [{ WindowName: "MainMenu", NodeId: "window-main", Visible: true, ActiveInHierarchy: true }],
          Nodes: [{ NodeId: "start", Label: "start journey", WindowName: "MainMenu", Clickable: true, SupportedActions: ["click"] }]
        }
      };
    case "scene.snapshot":
      return { ok: true, data: { SceneName: "MainScene", TotalObjects: 0, Objects: [] } };
    case "game.legal_actions":
      return { ok: true, data: { Phase: "menu", Actions: [] } };
    case "battle.snapshot":
      return { ok: false, error: "battle.snapshot unavailable in old bridge" };
    default:
      return { ok: true, data: {} };
  }
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
