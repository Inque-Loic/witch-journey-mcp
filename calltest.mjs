import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 19171;
let captured = null;
const bridge = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => {
    body += chunk;
  });
  request.on("end", () => {
    captured = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, echo: captured }));
  });
});

bridge.listen(port, "127.0.0.1");
await once(bridge, "listening");

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, WITCH_JOURNEY_BRIDGE_URL: `http://127.0.0.1:${port}` },
  stdio: ["pipe", "pipe", "inherit"]
});

let output = Buffer.alloc(0);
const messages = [];
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
    const body = output.subarray(bodyStart, bodyStart + length).toString("utf8");
    output = output.subarray(bodyStart + length);
    messages.push(JSON.parse(body));
  }
});

function send(id, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

send(1, "initialize", {});
send(2, "tools/call", {
  name: "witch_ui_snapshot",
  arguments: { includeHidden: true, scope: "main" }
});
send(3, "tools/call", {
  name: "witch_ui_interact",
  arguments: { action: "click", selector: { label: "开始旅途" } }
});

await new Promise(resolve => setTimeout(resolve, 500));
child.kill();
await once(child, "exit");
bridge.close();

const call = messages.find(x => x.id === 2);
const unicodeCall = messages.find(x => x.id === 3);
if (!call?.result || !unicodeCall?.result || captured?.command !== "ui.interact" || captured?.params?.selector?.label !== "开始旅途") {
  console.error(JSON.stringify({ messages, captured }, null, 2));
  process.exit(1);
}

console.log("ok: tool call forwarded");
