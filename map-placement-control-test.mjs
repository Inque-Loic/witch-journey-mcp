import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19188;
let clickCount = 0;
let mapPlaceCount = 0;
let slotFilled = false;

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
send(2, "tools/call", { name: "witch_map_place_card", arguments: { cardLabel: "经典肉鸽", slotIndex: 0, dryRun: true } });
await waitForMessage(2);
send(3, "tools/call", { name: "witch_map_place_card", arguments: { cardLabel: "经典肉鸽", slotIndex: 0, dryRun: false, timeoutMs: 50 } });
await waitForMessage(3);
send(4, "tools/call", { name: "witch_execute_operation", arguments: { label: "经典肉鸽", dryRun: true } });
await waitForMessage(4);

child.kill();
await once(child, "exit");
bridge.close();

const dryRun = textResult(2);
if (!dryRun.ok || dryRun.selectedCard.label !== "经典肉鸽" || dryRun.selectedSlot.role !== "slot") {
  throw new Error(`map place dry-run did not select card/slot ${JSON.stringify(dryRun, null, 2)}`);
}

const executed = textResult(3);
if (clickCount !== 0) {
  throw new Error(`semantic map placement should not use fallback clicks, got ${clickCount}`);
}
if (mapPlaceCount !== 1) {
  throw new Error(`expected one semantic map.place_card call, got ${mapPlaceCount}`);
}
if (executed.ok !== true || executed.slotVerification?.filled !== true) {
  throw new Error(`map place should verify the slot was filled ${JSON.stringify(executed, null, 2)}`);
}
if (executed.postSummary) {
  throw new Error(`post summary should be omitted by default ${JSON.stringify(executed, null, 2)}`);
}

const operation = textResult(4);
if (operation.selected.action !== "click") {
  throw new Error(`execute_operation should prefer click over hover ${JSON.stringify(operation, null, 2)}`);
}

console.log("ok: map placement control");

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
    case "ui.interact":
      if (params.action === "click") clickCount++;
      return { ok: true, action: params.action, selector: params.selector };
    case "map.place_card":
      mapPlaceCount++;
      slotFilled = true;
      return {
        ok: true,
        data: {
          ok: true,
          selectedCard: { path: params.cardPath, label: params.cardLabel },
          selectedSlot: { path: params.slotPath, label: params.slotLabel },
          slotFillAfter: { ok: true, filled: true, childCount: 1 }
        }
      };
    case "scene.snapshot":
      return { ok: true, data: { Objects: [] } };
    case "battle.snapshot":
      return { ok: true, data: { cards: [], targets: [] } };
    case "game.legal_actions":
      return { ok: true, data: { Phase: "map", Actions: [] } };
    case "runtime.objects":
      return {
        ok: true,
        data: {
          objects: slotFilled
            ? [
                { name: "Content", instanceId: 201, path: "Canvas/MapSelectUI/Top/PathSlot0/Content", activeSelf: true, activeInHierarchy: true },
                { name: "MapCard", instanceId: 202, path: "Canvas/MapSelectUI/Top/PathSlot0/Content/MapCard", activeSelf: true, activeInHierarchy: true }
              ]
            : []
        }
      };
    default:
      return { ok: false, error: `unexpected ${command}` };
  }
}

function uiSnapshot() {
  return {
    ok: true,
    data: {
      LayoutSignature: "same-map-layout",
      Windows: [
        { WindowName: "MapSelectUI", NodeId: "map-window", Visible: true, ActiveInHierarchy: true }
      ],
      Nodes: [
        {
          NodeId: "MapSelectUI|Canvas/MapSelectUI/Bottom/Card0|101",
          Label: "经典肉鸽",
          Text: "经典肉鸽",
          WindowName: "MapSelectUI",
          TransformPath: "Canvas/MapSelectUI/Bottom/Card0",
          Visible: true,
          ActiveInHierarchy: true,
          Interactable: true,
          Clickable: true,
          ComponentTypes: ["Button", "MapItem", "Card"],
          SupportedActions: ["hover", "click"]
        },
        {
          NodeId: "MapSelectUI|Canvas/MapSelectUI/Top/PathSlot0|102",
          Label: "路径槽 0",
          Text: "路径槽 0",
          WindowName: "MapSelectUI",
          TransformPath: "Canvas/MapSelectUI/Top/PathSlot0",
          Visible: true,
          ActiveInHierarchy: true,
          Interactable: true,
          Clickable: true,
          ComponentTypes: ["Button", "PathSlot"],
          SupportedActions: ["click"]
        }
      ]
    }
  };
}
