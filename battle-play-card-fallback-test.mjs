import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19174;
const commands = [];

const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method === "GET" && request.url === "/health") {
      respond(response, { ok: true, bridge: "fake-old-bridge", version: "test" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/command") {
      respond(response, { ok: false, error: "unexpected route" }, 404);
      return;
    }

    const payload = JSON.parse(body || "{}");
    commands.push({ command: payload.command, params: payload.params || {} });
    if (payload.command === "battle.play_card") {
      respond(response, { ok: false, error: "System.InvalidOperationException: Unknown command: battle.play_card" });
      return;
    }
    if (payload.command === "runtime.invoke_static") {
      respond(response, {
        ok: true,
        data: {
          typeName: payload.params.typeName,
          methodName: payload.params.methodName,
          result: { Success: true }
        }
      });
      return;
    }
    respond(response, { ok: false, error: `unexpected ${payload.command}` });
  });
});

bridge.listen(port, "127.0.0.1");
await once(bridge, "listening");

let child = null;
try {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}`
    },
    stdio: ["pipe", "pipe", "inherit"]
  });

  const messages = collectMcpMessages(child);
  send(child, 1, "initialize", {});
  await waitForMessage(messages, 1);
  send(child, 2, "tools/call", {
    name: "witch_play_card",
    arguments: {
      cardIndex: 0,
      cardId: "spark",
      targetIndex: 0,
      targetName: "Slime"
    }
  });
  await waitForMessage(messages, 2);

  const result = textResult(messages, 2);
  if (result.ok !== true || result.source !== "runtime.invoke_static" || result.fallbackFrom !== "battle.play_card") {
    throw new Error(`bad play-card fallback result ${JSON.stringify(result, null, 2)}`);
  }
  if (commands[0]?.command !== "battle.play_card" || commands[1]?.command !== "runtime.invoke_static") {
    throw new Error(`unexpected bridge commands ${JSON.stringify(commands, null, 2)}`);
  }
  const runtimeParams = commands[1].params;
  if (runtimeParams.typeName !== "Witch.UI.Automation.RuntimeBattleAutomationService" || runtimeParams.methodName !== "PlayCardAsync") {
    throw new Error(`unexpected runtime fallback params ${JSON.stringify(runtimeParams, null, 2)}`);
  }
  if (runtimeParams.arguments?.[0]?.cardId !== "spark" || runtimeParams.arguments?.[0]?.targetName !== "Slime") {
    throw new Error(`play-card arguments were not preserved ${JSON.stringify(runtimeParams, null, 2)}`);
  }
} finally {
  if (child) {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
  bridge.close();
}

console.log("ok: battle play-card runtime fallback");

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
