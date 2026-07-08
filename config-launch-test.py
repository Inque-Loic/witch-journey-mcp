import json
import pathlib
import subprocess
import sys
import tomllib


def frame(payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


def read_frame(stream):
    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = stream.read(1)
        if not chunk:
            raise RuntimeError("server closed before headers")
        headers += chunk
    header_blob, rest = headers.split(b"\r\n\r\n", 1)
    length = None
    for line in header_blob.decode("ascii").split("\r\n"):
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    if length is None:
        raise RuntimeError(f"missing content-length: {header_blob!r}")
    body = rest + stream.read(length - len(rest))
    return json.loads(body.decode("utf-8"))


config = pathlib.Path.home() / ".codex" / "config.toml"
data = tomllib.loads(config.read_text(encoding="utf-8"))
server = data["mcp_servers"]["witchJourney"]
env = None
if "env" in server:
    import os

    env = os.environ.copy()
    env.update(server["env"])

proc = subprocess.Popen(
    [server["command"], *server.get("args", [])],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env,
)

try:
    proc.stdin.write(frame({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
    proc.stdin.write(frame({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}))
    proc.stdin.flush()
    first = read_frame(proc.stdout)
    second = read_frame(proc.stdout)
finally:
    proc.kill()

if first.get("id") != 1 or second.get("id") != 2:
    print(json.dumps([first, second], ensure_ascii=False, indent=2))
    sys.exit(1)

tools = second.get("result", {}).get("tools", [])
print(f"ok: launched configured MCP server with {len(tools)} tools")
