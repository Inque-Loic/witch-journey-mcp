import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19185;

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
send(2, "tools/list", {});
await waitForMessage(2);
send(3, "tools/call", {
  name: "witch_assert_ui_text",
  arguments: { expectedTexts: ["传奇揭幕"], onlyInteractive: false }
});
await waitForMessage(3);
send(4, "tools/call", {
  name: "witch_assert_forbidden_text",
  arguments: { forbiddenTexts: ["黑匣回执"], onlyInteractive: false }
});
await waitForMessage(4);
send(5, "tools/call", {
  name: "witch_assert_event_id",
  arguments: { expectedEventId: "event_2001", includeHookLog: false }
});
await waitForMessage(5);
send(6, "tools/call", {
  name: "witch_assert_route",
  arguments: {
    expectedEventIds: ["event_2001"],
    expectedMapNodes: ["node_7"],
    expectedTexts: ["传奇揭幕"],
    forbiddenTexts: ["黑匣回执"],
    minConfidence: 0.5,
    onlyInteractive: false,
    includeHookLog: false
  }
});
await waitForMessage(6);

child.kill();
await once(child, "exit");
bridge.close();

const init = messages.find(item => item.id === 1);
if (init.result.serverInfo.version !== "0.9.0") {
  throw new Error(`unexpected server version ${JSON.stringify(init, null, 2)}`);
}

const tools = messages.find(item => item.id === 2).result.tools;
for (const name of ["witch_assert_route", "witch_assert_ui_text", "witch_assert_event_id", "witch_assert_forbidden_text"]) {
  if (!tools.some(tool => tool.name === name)) {
    throw new Error(`missing assertion tool ${name}`);
  }
}

for (const id of [3, 4, 5, 6]) {
  const result = JSON.parse(messages.find(item => item.id === id).result.content[0].text);
  if (result.ok !== true) {
    throw new Error(`assertion ${id} failed ${JSON.stringify(result, null, 2)}`);
  }
}

console.log("ok: assertion tools");

function respond(response, data, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function commandResult(command, params) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "fake", version: "0.9.0" } };
    case "ui.snapshot":
      return {
        ok: true,
        data: {
          Windows: [
            { WindowName: "MapSelectUI", NodeId: "window-map", Visible: true, ActiveInHierarchy: true }
          ],
          Nodes: [
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
              ComponentTypes: ["MapItem"],
              SupportedActions: ["click"]
            }
          ]
        }
      };
    case "game.legal_actions":
      return {
        ok: true,
        data: {
          Phase: "event",
          Actions: [
            { Id: "event_2001", Kind: "event_choice", Label: "传奇揭幕", Description: "Load event" }
          ]
        }
      };
    case "runtime.objects":
      return runtimeObjects(params.componentType);
    case "runtime.object_detail":
      return runtimeObjectDetail(params.componentType);
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
}

function runtimeObjects(componentType) {
  if (componentType === "MapItem") {
    return {
      ok: true,
      data: {
        objects: [
          { name: "LegendMapItem", instanceId: 401, path: "Canvas/MapSelectUI/node_7", activeInHierarchy: true, components: [{ type: "MapItem", name: "MapItem", enabled: true }] }
        ]
      }
    };
  }
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
  const members = componentType === "MapItem"
    ? [
        { kind: "field", name: "nodeId", type: "System.String", value: "node_7", readable: true },
        { kind: "field", name: "eventId", type: "System.String", value: "event_2001", readable: true }
      ]
    : [
        { kind: "field", name: "currentMapNodeId", type: "System.String", value: "node_7", readable: true }
      ];
  return {
    ok: true,
    data: {
      found: true,
      components: [
        { type: componentType, name: componentType, members }
      ]
    }
  };
}
