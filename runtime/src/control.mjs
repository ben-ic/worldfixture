// Private lifecycle control for one foreground instance.
//
// A Unix socket keeps reset off every application port. The process that owns
// the children also owns this socket, so a second CLI process can request reset
// without guessing PIDs or touching service files itself.

import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { shareHostOwnership } from './host-state-ownership.mjs';
import { readActiveGeneration } from './session-files.mjs';

const socketPath = (stateDir) => join(stateDir, "control.sock");

export async function serveControl(instance, stateDir) {
  const path = socketPath(stateDir);
  rmSync(path, { force: true });

  const server = createServer((socket) => {
    let input = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 1024 * 1024) return socket.destroy();
      if (!input.includes("\n")) return;

      handled = true;
      try {
        const line = input.slice(0, input.indexOf("\n")).trim();
        const command = line === 'reset' ? { action: 'reset' } : JSON.parse(line);
        if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Control command must be an object');
        let result;
        const session = instance.sessionManager;
        if (session) {
          const { generation, ...operation } = command;
          if (operation.action === 'session-status') result = session.status();
          else if (operation.action === 'worlds') result = { worlds: await session.catalogue() };
          else if (operation.action === 'switch') result = await session.switchWorld(operation.input, generation);
          else if (operation.action === 'confirm-connection') result = await session.confirmConnection(operation.input, generation);
          else if (operation.action === 'operation') result = await session.operation(operation.input, generation);
          else result = await session.clockCommand(operation, generation);
        } else if (instance.timelineControl) result = await instance.timelineControl.command(command);
        else if (command.action === 'reset') result = await instance.reset();
        else { const error = new Error('Timeline control is not initialized'); error.code = 'timeline_not_initialized'; error.status = 503; throw error; }
        socket.end(`${JSON.stringify({ ok: true, ...result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message, code: error.code ?? 'bad_control', status: error.status ?? 400, state_changed: error.state_changed, result: error.result, detail: error.detail })}\n`);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  shareHostOwnership(path);

  return {
    path,
    close: () => new Promise((resolve) => server.close(() => {
      rmSync(path, { force: true });
      resolve();
    })),
  };
}

export function requestControl(stateDir, command, { timeoutMs = 120_000 } = {}) {
  const active = readActiveGeneration(stateDir, { allowTransition: true });
  if (active && command.generation === undefined) command = { ...command, generation: active.generation };
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(stateDir));
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("runtime control timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => (output += chunk));
    socket.on("end", () => {
      try {
        const response = JSON.parse(output);
        if (!response.ok) { const error = new Error(response.error); error.code = response.code; error.status = response.status; error.result = response.result; error.state_changed = response.state_changed; error.detail = response.detail; reject(error); }
        else resolve(response);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function requestReset(stateDir, options) {
  return requestControl(stateDir, { action: 'reset' }, options);
}
