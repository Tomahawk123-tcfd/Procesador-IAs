"""
LinkCore Python SDK

The CUDA for AI models.
One line to use 50 models as if they were one.

Usage:
    from linkcore import LinkCore
    lc = LinkCore()
    res = lc.ask("hazme un login con JWT")
    print(res["text"], res["model"], res["latency_ms"])
"""

import json
import os
import socket
import time


DEFAULT_PIPE = (
    "\\\\.\\pipe\\linkcore" if os.name == "nt" else "/tmp/linkcore.sock"
)


class LinkCore:
    def __init__(self, pipe=None, timeout=120, retries=2):
        self.pipe = pipe or DEFAULT_PIPE
        self.timeout = timeout
        self.retries = retries

    def ask(self, query, on_progress=None):
        if not query or not str(query).strip():
            raise ValueError("query_required")

        last_error = None
        for attempt in range(self.retries + 1):
            try:
                result = self._send(
                    {"type": "ask", "query": str(query).strip()},
                    on_progress=on_progress,
                )
                if result.get("type") == "error":
                    raise RuntimeError(result.get("error", "unknown_error"))

                data = result.get("data", {})
                return {
                    "text": data.get("response") or data.get("text") or "",
                    "model": data.get("model"),
                    "provider": data.get("provider"),
                    "latency_ms": data.get("latencyMs", 0),
                    "sector": data.get("sector"),
                    "tools": data.get("tools", []),
                    "ensemble": data.get("ensemble"),
                    "trace": data.get("trace", []),
                }
            except Exception as e:
                last_error = e
                if attempt < self.retries:
                    time.sleep(1 * (attempt + 1))

        raise last_error

    def status(self):
        result = self._send({"type": "status"})
        if result.get("type") == "error":
            raise RuntimeError(result.get("error"))
        return result.get("data", {})

    def chip(self):
        result = self._send({"type": "chip"})
        if result.get("type") == "error":
            raise RuntimeError(result.get("error"))
        return result.get("data", {})

    def health(self):
        try:
            status = self.status()
            return {
                "ok": True,
                "service": status.get("service"),
                "version": status.get("version"),
                "uptime": status.get("uptimeSec"),
                "ollama": (
                    status.get("ollama", {}).get("corriendo", False)
                    if status.get("ollama")
                    else False
                ),
                "chip": status.get("chip"),
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def models(self):
        chip = self.chip()
        installed = []
        if chip and chip.get("health", {}).get("ollama", {}).get("models"):
            installed = chip["health"]["ollama"]["models"]
        return {
            "installed": installed,
            "stats": chip.get("modelStats", {}),
            "learning": chip.get("learning"),
        }

    def _send(self, request, on_progress=None):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) if os.name != "nt" else None

        if os.name == "nt":
            return self._send_windows(request, on_progress)

        try:
            s.connect(self.pipe)
            s.settimeout(self.timeout)

            s.sendall((json.dumps(request) + "\n").encode())

            buffer = b""
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    msg = json.loads(line.decode())

                    if msg.get("type") == "progress" and on_progress:
                        on_progress(msg.get("event"))
                        continue

                    if msg.get("type") in ("done", "status", "chip", "error"):
                        return msg
        finally:
            if s:
                s.close()

    def _send_windows(self, request, on_progress=None):
        """
        Windows named pipe client using connect-pipe approach.
        Falls back to subprocess call to the CLI if direct connection fails.
        """
        import subprocess
        import sys

        args = [sys.executable, "-c", f"""
import json, sys, socket, os
req = {json.dumps(request)}
# On Windows, try named pipe via subprocess
print(json.dumps(req))
"""]

        # Use the CLI as a fallback on Windows
        result = subprocess.run(
            [
                "node",
                "-e",
                f"""
const net = require('net');
const rl = require('readline');
var s = net.connect('{self.pipe}');
s.write(JSON.stringify({json.dumps(request)}) + '\\n');
var buf = '';
s.on('data', function(d) {{
  buf += d.toString();
  var lines = buf.split('\\n');
  buf = lines.pop();
  lines.forEach(function(line) {{
    if (!line.trim()) return;
    var msg = JSON.parse(line);
    if (msg.type === 'progress') process.stderr.write(JSON.stringify(msg.event) + '\\n');
    else if (msg.type === 'done' || msg.type === 'status' || msg.type === 'chip' || msg.type === 'error') {{
      process.stdout.write(JSON.stringify(msg));
      s.destroy();
    }}
  }});
}});
s.on('error', function(e) {{ process.stderr.write(e.message); process.exit(1); }});
setTimeout(function() {{ process.exit(1); }}, {self.timeout * 1000});
""",
            ],
            capture_output=True,
            text=True,
            timeout=self.timeout + 5,
        )

        if result.returncode != 0:
            raise RuntimeError(result.stderr or "connection_failed")

        return json.loads(result.stdout)
