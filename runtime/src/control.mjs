// Private lifecycle control for one foreground instance.
//
// A Unix socket keeps reset off every application port. The process that owns
// the children also owns this socket, so a second CLI process can request reset
// without guessing PIDs or touching service files itself.

import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

export const socketPath = (stateDir) => join(stateDir, "control.sock");

export async function serveControl(instance, stateDir) {
  const path = socketPath(stateDir);
  rmSync(path, { force: true });
  let resetting = false;

  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      input += chunk;
      if (input.length > 4096) return socket.destroy();
      if (!input.includes("\n")) return;

      const command = input.slice(0, input.indexOf("\n")).trim();
      if (command !== "reset") {
        socket.end(`${JSON.stringify({ ok: false, error: "unknown control command" })}\n`);
        return;
      }
      if (resetting) {
        socket.end(`${JSON.stringify({ ok: false, error: "reset is already in progress" })}\n`);
        return;
      }

      resetting = true;
      try {
        const result = await instance.reset();
        socket.end(`${JSON.stringify({ ok: true, ...result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      } finally {
        resetting = false;
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);

  return {
    path,
    close: () => new Promise((resolve) => server.close(() => {
      rmSync(path, { force: true });
      resolve();
    })),
  };
}

export function requestReset(stateDir, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(stateDir));
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("reset timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write("reset\n"));
    socket.on("data", (chunk) => (output += chunk));
    socket.on("end", () => {
      try {
        const response = JSON.parse(output);
        if (!response.ok) reject(new Error(response.error));
        else resolve(response);
      } catch (error) {
        reject(error);
      }
    });
  });
}
