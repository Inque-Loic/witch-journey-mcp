import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19184;

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
send(2, "tools/call", {
  name: "witch_event_route_trace",
  arguments: {
    includeHidden: false,
    onlyInteractive: true,
    includeComponentDetails: true
  }
});
await waitForMessage(2);

child.kill();
await once(child, "exit");
bridge.close();

const resultMessage = messages.find(item => item.id === 2);
const trace = JSON.parse(resultMessage.result.content[0].text);
if (!trace.ok || trace.confidence <= 0.5) {
  throw new Error(`trace did not return confident ok result ${JSON.stringify(trace, null, 2)}`);
}
if (!trace.route?.some(step => step.name === "event_candidates")) {
  throw new Error(`trace did not include event route step ${JSON.stringify(trace, null, 2)}`);
}
if (!trace.eventCandidates?.some(item => item.value === "event_2001")) {
  throw new Error(`trace did not extract legal event id ${JSON.stringify(trace, null, 2)}`);
}
if (!trace.eventCandidates?.some(item => item.value === "EchoEnding_echo_event_echo_archive")) {
  throw new Error(`trace did not extract runtime event id ${JSON.stringify(trace, null, 2)}`);
}
if (!trace.mapCandidates?.some(item => item.value === "node_7")) {
  throw new Error(`trace did not extract map node ${JSON.stringify(trace, null, 2)}`);
}
if (!trace.componentFields?.some(item => item.name === "eventId" && item.value === "EchoEnding_echo_event_echo_archive")) {
  throw new Error(`trace did not include eventId component field ${JSON.stringify(trace, null, 2)}`);
}

console.log("ok: event route trace");

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
          Windows: [
            { WindowName: "MapSelectUI", NodeId: "window-map", Visible: true, ActiveInHierarchy: true },
            { WindowName: "EventUI", NodeId: "window-event", Visible: true, ActiveInHierarchy: true }
          ],
          Nodes: [
            {
              NodeId: "EventUI|Canvas/EventUI/Windows/Map0/Content/Selector/event_2001|101",
              Label: "回声档案录",
              Text: "回声档案录",
              WindowName: "EventUI",
              TransformPath: "Canvas/EventUI/Windows/Map0/Content/Selector/event_2001",
              Interactable: true,
              Clickable: true,
              ComponentTypes: ["Button", "EventOption"],
              SupportedActions: ["click", "submit"]
            },
            {
              NodeId: "MapSelectUI|Canvas/MapSelectUI/node_7|102",
              Label: "档案地图节点",
              WindowName: "MapSelectUI",
              TransformPath: "Canvas/MapSelectUI/node_7",
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
            { Id: "event_2001", Kind: "event_choice", Label: "回声档案录", Description: "Load archive event" }
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
  const objects = {
    MapManager: [
      { name: "MapManager", instanceId: 301, path: "Managers/MapManager", activeInHierarchy: true, components: [{ type: "MapManager", name: "MapManager", enabled: true }] }
    ],
    NormalMapManager: [
      { name: "NormalMapManager", instanceId: 302, path: "Managers/NormalMapManager", activeInHierarchy: true, components: [{ type: "NormalMapManager", name: "NormalMapManager", enabled: true }] }
    ],
    MapItem: [
      { name: "ArchiveMapItem", instanceId: 401, path: "Canvas/MapSelectUI/node_7", activeInHierarchy: true, components: [{ type: "MapItem", name: "MapItem", enabled: true }] }
    ],
    EventUI: [
      { name: "EventUI", instanceId: 501, path: "Canvas/EventUI", activeInHierarchy: true, components: [{ type: "EventUI", name: "EventUI", enabled: true }] }
    ],
    EventManager: []
  };
  return { ok: true, data: { objects: objects[componentType] || [] } };
}

function runtimeObjectDetail(componentType) {
  if (componentType === "MapItem") {
    return {
      ok: true,
      data: {
        found: true,
        components: [
          {
            type: "MapItem",
            name: "MapItem",
            members: [
              { kind: "field", name: "nodeId", type: "System.String", value: "node_7", readable: true },
              { kind: "field", name: "eventId", type: "System.String", value: "EchoEnding_echo_event_echo_archive", readable: true },
              { kind: "field", name: "nodeData", type: "MapNodeData", value: { id: "node_7", eventId: "EchoEnding_echo_event_echo_archive" }, readable: true }
            ]
          }
        ]
      }
    };
  }
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
