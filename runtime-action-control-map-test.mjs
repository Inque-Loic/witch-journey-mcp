import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19182;
const commands = [];

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
    commands.push({ command: payload.command, params: payload.params || {} });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(commandResult(payload.command, payload.params || {})));
  });
});

bridge.listen(port, "127.0.0.1");
await once(bridge, "listening");

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}`
  },
  stdio: ["pipe", "pipe", "inherit"]
});

try {
  const messages = collectMcpMessages(child);
  send(child, 1, "initialize", {});
  await waitForMessage(messages, 1);

  send(child, 2, "tools/call", {
    name: "witch_control_map",
    arguments: {
      includeUi: false,
      includeScene: false,
      includeBattle: false,
      includeActions: false,
      includeRuntimeActions: true
    }
  });
  await waitForMessage(messages, 2);
  const controlMap = textResult(messages, 2);
  const runtimeAction = (controlMap.operations || []).find(item => item.id.includes("NormalMapManager") && item.id.includes("ShowMapSelect"));
  if (!runtimeAction || runtimeAction.family !== "runtime_action" || runtimeAction.ready !== false) {
    throw new Error(`runtime action was not exposed conservatively ${JSON.stringify(controlMap, null, 2)}`);
  }

  send(child, 3, "tools/call", {
    name: "witch_execute_operation",
    arguments: {
      operationId: runtimeAction.id,
      dryRun: true,
      includeUi: false,
      includeScene: false,
      includeBattle: false,
      includeActions: false,
      includeRuntimeActions: true
    }
  });
  await waitForMessage(messages, 3);
  const preview = textResult(messages, 3);
  if (preview.ok !== true || preview.result?.skipped !== true || preview.plannedCall?.tool !== "witch_runtime_component_call") {
    throw new Error(`runtime action dry-run preview failed ${JSON.stringify(preview, null, 2)}`);
  }

  send(child, 4, "tools/call", {
    name: "witch_execute_operation",
    arguments: {
      operationId: runtimeAction.id,
      dryRun: false,
      includeUi: false,
      includeScene: false,
      includeBattle: false,
      includeActions: false,
      includeRuntimeActions: true
    }
  });
  await waitForMessage(messages, 4);
  const refused = textResult(messages, 4);
  if (refused.reason !== "operation_requires_arguments") {
    throw new Error(`runtime action executed without confirmation ${JSON.stringify(refused, null, 2)}`);
  }

  send(child, 5, "tools/call", {
    name: "witch_execute_operation",
    arguments: {
      operationId: runtimeAction.id,
      dryRun: false,
      includeUi: false,
      includeScene: false,
      includeBattle: false,
      includeActions: false,
      includeRuntimeActions: true,
      arguments: {
        dryRun: false,
        confirm: "CALL_WITCH_COMPONENT_METHOD"
      }
    }
  });
  await waitForMessage(messages, 5);
  const executed = textResult(messages, 5);
  if (executed.ok !== true || executed.result?.data?.methodName !== "ShowMapSelect") {
    throw new Error(`confirmed runtime action did not execute ${JSON.stringify(executed, null, 2)}`);
  }
} finally {
  child.kill();
  await once(child, "exit").catch(() => {});
  bridge.close();
}

console.log("ok: runtime action control map");

function commandResult(command, params) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "fake", version: "test" } };
    case "game.legal_actions":
      return { ok: true, data: { Phase: "unknown", Actions: [] } };
    case "ui.snapshot":
      return { ok: true, data: { Nodes: [], Windows: [] } };
    case "scene.snapshot":
      return { ok: true, data: { SceneName: "game", Objects: [] } };
    case "battle.snapshot":
      return { ok: true, data: { inBattle: false, cards: [], targets: [], supportedActions: ["play_card"] } };
    case "runtime.objects":
      if (params.componentType === "NormalMapManager") {
        return {
          ok: true,
          data: {
            objects: [
              {
                name: "ModeManager",
                instanceId: 501,
                path: "ModeManager",
                activeInHierarchy: true,
                components: [{ type: "Witch.NormalMapManager", name: "NormalMapManager", enabled: true }]
              }
            ]
          }
        };
      }
      return { ok: true, data: { objects: [] } };
    case "runtime.component_call":
      return {
        ok: params.dryRun === false && params.confirm === "CALL_WITCH_COMPONENT_METHOD",
        data: {
          componentType: params.componentType,
          methodName: params.methodName,
          dryRun: params.dryRun,
          confirm: params.confirm
        }
      };
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
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
