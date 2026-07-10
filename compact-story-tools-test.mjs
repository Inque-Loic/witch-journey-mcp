import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19187;

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
send(2, "tools/call", { name: "witch_state_summary", arguments: { compact: true, fields: ["activeWindows", "clickables", "legalActions"] } });
await waitForMessage(2);
send(3, "tools/call", { name: "witch_story_map_snapshot", arguments: { includeHookLog: false } });
await waitForMessage(3);
send(4, "tools/call", { name: "witch_event_choose_option", arguments: { text: "在家休息", dryRun: true } });
await waitForMessage(4);
send(5, "tools/call", { name: "witch_map_select_node", arguments: { label: "传奇揭幕", dryRun: true } });
await waitForMessage(5);
send(6, "tools/call", {
  name: "witch_runtime_component_call",
  arguments: {
    componentType: "MapManager",
    instanceId: 301,
    methodName: "CmdNextMap",
    arguments: [],
    dryRun: false,
    confirm: "CALL_WITCH_COMPONENT_METHOD",
    waitFor: { stateChanged: true, timeoutMs: 50, pollMs: 10 }
  }
});
await waitForMessage(6);

child.kill();
await once(child, "exit");
bridge.close();

const summary = textResult(2);
if (!Array.isArray(summary.activeWindows) || !Array.isArray(summary.clickables) || !summary.legalActions) {
  throw new Error(`compact summary did not honor fields ${JSON.stringify(summary, null, 2)}`);
}

const story = textResult(3);
if (story.currentWindow !== "EventUI" || !story.availableOptions.some(item => item.label === "在家休息")) {
  throw new Error(`story snapshot did not expose current event options ${JSON.stringify(story, null, 2)}`);
}

const eventChoice = textResult(4);
if (!eventChoice.ok || eventChoice.selected.label !== "在家休息" || eventChoice.plannedCall.tool !== "witch_ui_interact") {
  throw new Error(`event choose option failed ${JSON.stringify(eventChoice, null, 2)}`);
}

const mapChoice = textResult(5);
if (!mapChoice.ok || mapChoice.selected.label !== "传奇揭幕") {
  throw new Error(`map select node failed ${JSON.stringify(mapChoice, null, 2)}`);
}

const runtime = textResult(6);
if (runtime.ok !== false || runtime.reason !== "runtime_call_unverified_no_state_change") {
  throw new Error(`runtime waitFor did not fail unchanged state ${JSON.stringify(runtime, null, 2)}`);
}

console.log("ok: compact story tools");

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
          Phase: "event",
          Actions: [
            { Id: "event_2001", Kind: "event_choice", Label: "在家休息", Description: "Rest at home" }
          ]
        }
      };
    case "runtime.objects":
      return runtimeObjects(params.componentType);
    case "runtime.object_detail":
      return runtimeObjectDetail(params.componentType);
    case "runtime.component_call":
      return { ok: true, success: true };
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
}

function uiSnapshot() {
  return {
    ok: true,
    data: {
      LayoutSignature: "stable-layout",
      Windows: [
        { WindowName: "EventUI", NodeId: "event-window", Visible: true, ActiveInHierarchy: true },
        { WindowName: "MapSelectUI", NodeId: "map-window", Visible: true, ActiveInHierarchy: true },
        { WindowName: "HiddenEventUI", NodeId: "hidden-window", Visible: false, ActiveInHierarchy: false }
      ],
      Nodes: [
        {
          NodeId: "EventUI|Canvas/EventUI/Options/Rest|101",
          Label: "在家休息",
          Text: "在家休息",
          WindowName: "EventUI",
          TransformPath: "Canvas/EventUI/Options/Rest",
          Visible: true,
          ActiveInHierarchy: true,
          Interactable: true,
          Clickable: true,
          ComponentTypes: ["Button", "EventOption"],
          SupportedActions: ["click"]
        },
        {
          NodeId: "MapSelectUI|Canvas/MapSelectUI/node_7|102",
          Label: "传奇揭幕",
          Text: "传奇揭幕",
          WindowName: "MapSelectUI",
          TransformPath: "Canvas/MapSelectUI/node_7",
          Visible: true,
          ActiveInHierarchy: true,
          Interactable: true,
          Clickable: true,
          ComponentTypes: ["Button", "MapItem"],
          SupportedActions: ["click"]
        },
        {
          NodeId: "HiddenEventUI|Canvas/Hidden/Disabled|103",
          Label: "禁用选项",
          Text: "禁用选项",
          WindowName: "HiddenEventUI",
          TransformPath: "Canvas/Hidden/Disabled",
          Visible: false,
          ActiveInHierarchy: false,
          Interactable: false,
          Clickable: true,
          ComponentTypes: ["Button", "EventOption"],
          SupportedActions: ["click"]
        }
      ]
    }
  };
}

function runtimeObjects(componentType) {
  if (componentType === "MapManager") {
    return {
      ok: true,
      data: {
        objects: [
          { name: "MapManager", instanceId: 301, path: "Managers/MapManager", activeInHierarchy: true, components: [{ type: "MapManager", name: "MapManager", enabled: true }] }
        ]
      }
    };
  }
  return { ok: true, data: { objects: [] } };
}

function runtimeObjectDetail(componentType) {
  return {
    ok: true,
    data: {
      found: true,
      components: [
        {
          type: componentType,
          name: componentType,
          members: [
            { kind: "field", name: "currentEventId", type: "System.String", value: "event_2001", readable: true },
            { kind: "field", name: "currentMapNodeId", type: "System.String", value: "node_7", readable: true }
          ]
        }
      ]
    }
  };
}
