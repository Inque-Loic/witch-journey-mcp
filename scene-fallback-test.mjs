import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19176;
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
    if (payload.command === "scene.snapshot" || payload.command === "scene.interact" || payload.command === "scene.raycast") {
      respond(response, { ok: false, error: `System.InvalidOperationException: Unknown command: ${payload.command}` });
      return;
    }
    if (payload.command === "runtime.invoke_static") {
      respond(response, runtimeStaticResult(payload.params || {}));
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
  send(child, 2, "tools/call", { name: "witch_scene_snapshot", arguments: { onlyInteractive: true } });
  send(child, 3, "tools/call", {
    name: "witch_scene_interact",
    arguments: {
      action: "click",
      selector: { objectId: "door", name: "Door" }
    }
  });
  send(child, 4, "tools/call", { name: "witch_scene_raycast", arguments: { x: 12, y: 34, distance: 500 } });
  await waitForMessage(messages, 2);
  await waitForMessage(messages, 3);
  await waitForMessage(messages, 4);

  const snapshot = textResult(messages, 2);
  if (snapshot.ok !== true || snapshot.source !== "runtime.invoke_static" || snapshot.fallbackFrom !== "scene.snapshot" || snapshot.data?.Objects?.[0]?.ObjectId !== "door") {
    throw new Error(`bad scene snapshot fallback ${JSON.stringify(snapshot, null, 2)}`);
  }

  const interact = textResult(messages, 3);
  if (interact.ok !== true || interact.source !== "runtime.invoke_static" || interact.fallbackFrom !== "scene.interact" || interact.data?.Success !== true) {
    throw new Error(`bad scene interact fallback ${JSON.stringify(interact, null, 2)}`);
  }

  const raycast = textResult(messages, 4);
  if (raycast.ok !== true || raycast.source !== "runtime.invoke_static" || raycast.fallbackFrom !== "scene.raycast" || raycast.data?.Hits?.[0]?.ObjectId !== "door") {
    throw new Error(`bad scene raycast fallback ${JSON.stringify(raycast, null, 2)}`);
  }

  const runtimeCalls = commands.filter(item => item.command === "runtime.invoke_static").map(item => item.params);
  const methods = runtimeCalls.map(item => item.methodName);
  if (!methods.includes("CaptureSnapshot") || !methods.includes("InteractAsync") || !methods.includes("Raycast")) {
    throw new Error(`runtime fallbacks were not called ${JSON.stringify(commands, null, 2)}`);
  }
  const interactArgs = runtimeCalls.find(item => item.methodName === "InteractAsync")?.arguments?.[0];
  if (interactArgs?.selector?.objectId !== "door" || interactArgs?.selector?.name !== "Door") {
    throw new Error(`scene interact arguments were not preserved ${JSON.stringify(runtimeCalls, null, 2)}`);
  }
} finally {
  if (child) {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
  bridge.close();
}

console.log("ok: scene runtime fallback");

function runtimeStaticResult(params) {
  const base = {
    typeName: params.typeName,
    methodName: params.methodName
  };
  if (params.methodName === "CaptureSnapshot") {
    return {
      ok: true,
      data: {
        ...base,
        result: {
          SceneName: "MainScene",
          Objects: [
            { ObjectId: "door", Name: "Door", Interactive: true, SupportedActions: ["click"] }
          ]
        }
      }
    };
  }
  if (params.methodName === "InteractAsync") {
    return { ok: true, data: { ...base, result: { Success: true } } };
  }
  if (params.methodName === "Raycast") {
    return {
      ok: true,
      data: {
        ...base,
        result: {
          Hits: [
            { ObjectId: "door", Name: "Door", Distance: 42 }
          ]
        }
      }
    };
  }
  return { ok: false, error: `unexpected method ${params.methodName}` };
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
