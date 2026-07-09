import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19181;

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
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
    name: "witch_battle_snapshot",
    arguments: { includeInactive: true, maxCards: 10, maxTargets: 10 }
  });
  await waitForMessage(messages, 2);

  const snapshot = textResult(messages, 2);
  if (snapshot.ok !== true || snapshot.source !== "runtime.objects") {
    throw new Error(`expected runtime fallback snapshot ${JSON.stringify(snapshot, null, 2)}`);
  }
  if (snapshot.inBattle !== false || snapshot.targetCount !== 1 || snapshot.activeTargetCount !== 0) {
    throw new Error(`inactive targets must not prove live battle ${JSON.stringify(snapshot, null, 2)}`);
  }
} finally {
  child.kill();
  await once(child, "exit").catch(() => {});
  bridge.close();
}

console.log("ok: inactive runtime battle objects are not live battle");

function commandResult(command, params) {
  switch (command) {
    case "status":
      return { ok: true, data: { bridge: "fake-old-bridge", version: "test" } };
    case "battle.snapshot":
      return { ok: false, error: "System.InvalidOperationException: Unknown command: battle.snapshot" };
    case "runtime.objects":
      if (params.componentType === "EnemyItem") {
        return {
          ok: true,
          data: {
            objects: [
              {
                name: "Dictionary Enemy",
                instanceId: 101,
                path: "Canvas/DictionaryUI/Content/items/Dictionary Enemy",
                activeInHierarchy: false,
                components: [{ type: "Witch.UI.Window.EnemyItem", name: "EnemyItem", enabled: true }]
              }
            ]
          }
        };
      }
      return { ok: true, data: { objects: [] } };
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
