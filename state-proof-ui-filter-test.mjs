import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19186;
let performedActions = 0;

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
    respond(response, commandResult(payload.command, payload.params || {}));
  });
});

bridge.listen(port, "127.0.0.1");
await once(bridge, "listening");

const child = spawn("node", ["server.mjs"], {
  env: {
    ...process.env,
    WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}`,
    WITCH_JOURNEY_NO_MOUSE: "true"
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
    const bodyText = output.subarray(bodyStart, bodyStart + length).toString("utf8");
    output = output.subarray(bodyStart + length);
    messages.push(JSON.parse(bodyText));
  }
});

function send(id, method, params) {
  const bodyText = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(bodyText, "utf8")}\r\n\r\n${bodyText}`);
}

async function waitForMessage(id) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    const message = messages.find(item => item.id === id);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for message ${id}`);
}

send(1, "initialize", {});
await waitForMessage(1);
send(2, "tools/call", { name: "witch_ui_snapshot", arguments: { includeHidden: false } });
await waitForMessage(2);
send(3, "tools/call", { name: "witch_control_map", arguments: { includeHidden: false, onlyInteractive: true } });
await waitForMessage(3);
send(4, "tools/call", {
  name: "witch_execute_operation",
  arguments: {
    operationId: "legal:map_continue",
    dryRun: false,
    postVerifyDelayMs: 1
  }
});
await waitForMessage(4);

child.kill();
await once(child, "exit");
bridge.close();

const uiSnapshotResult = textResult(2);
if (uiSnapshotResult.data.Windows.some(item => item.WindowName === "HiddenArchiveUI")) {
  throw new Error(`hidden window leaked into UI snapshot ${JSON.stringify(uiSnapshotResult, null, 2)}`);
}
if (uiSnapshotResult.data.Nodes.some(item => item.Label === "黑匣回执")) {
  throw new Error(`hidden node leaked into UI snapshot ${JSON.stringify(uiSnapshotResult, null, 2)}`);
}

const controlMap = textResult(3);
const recommended = controlMap.recommendedOperations || [];
if (!recommended.some(item => item.intent === "reward_confirm" && item.label === "领取奖励并确认")) {
  throw new Error(`reward confirm operation was not recommended ${JSON.stringify(controlMap, null, 2)}`);
}

const execute = textResult(4);
if (performedActions !== 1) {
  throw new Error(`expected map_continue action to be called once, got ${performedActions}`);
}
if (execute.ok !== false || execute.reason !== "operation_unverified_no_state_change") {
  throw new Error(`map_continue without state change should fail proof ${JSON.stringify(execute, null, 2)}`);
}
if (execute.stateProof?.changed !== false) {
  throw new Error(`expected unchanged state proof ${JSON.stringify(execute, null, 2)}`);
}

console.log("ok: state proof and UI filtering");

function textResult(id) {
  const message = messages.find(item => item.id === id);
  return JSON.parse(message.result.content[0].text);
}

function respond(response, data, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function commandResult(command, params) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "fake", version: "0.9.0" } };
    case "ui.snapshot":
      return uiSnapshot();
    case "scene.snapshot":
      return { ok: true, data: { Objects: [] } };
    case "battle.snapshot":
      return { ok: true, data: { cards: [], targets: [] } };
    case "game.legal_actions":
      return {
        ok: true,
        data: {
          Phase: "map",
          Actions: [
            { Id: "map_continue", Kind: "map_continue", Label: "继续地图", Description: "Continue map, but fake bridge will not change state" }
          ]
        }
      };
    case "game.perform_action":
      performedActions++;
      return { ok: true, actionId: params.actionId || null, success: true };
    case "runtime.objects":
      return { ok: true, data: { objects: [] } };
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
}

function uiSnapshot() {
  return {
    ok: true,
    data: {
      LayoutSignature: "same-layout",
      Windows: [
        { WindowName: "RewardUI", NodeId: "reward-window", Visible: true, ActiveInHierarchy: true },
        { WindowName: "HiddenArchiveUI", NodeId: "hidden-window", Visible: false, ActiveInHierarchy: false }
      ],
      Nodes: [
        {
          NodeId: "RewardUI|Canvas/RewardUI/Confirm|1",
          Label: "领取奖励并确认",
          Text: "领取奖励并确认",
          WindowName: "RewardUI",
          TransformPath: "Canvas/RewardUI/Confirm",
          Visible: true,
          ActiveInHierarchy: true,
          Interactable: true,
          Clickable: true,
          ComponentTypes: ["Button"],
          SupportedActions: ["click", "submit"]
        },
        {
          NodeId: "HiddenArchiveUI|Canvas/HiddenArchiveUI/Text|2",
          Label: "黑匣回执",
          Text: "黑匣回执",
          WindowName: "HiddenArchiveUI",
          TransformPath: "Canvas/HiddenArchiveUI/Text",
          Visible: false,
          ActiveInHierarchy: false,
          Interactable: false,
          Clickable: false,
          ComponentTypes: ["Text"],
          SupportedActions: []
        }
      ]
    }
  };
}
