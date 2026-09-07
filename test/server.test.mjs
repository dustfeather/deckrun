import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Starts the CLI and resolves once it has printed the URL it is serving.
 *
 * The port is read back out of that line rather than assumed, because the CLI
 * falls through to whatever the OS offers when the preferred port is taken.
 */
async function startServer(args = []) {
  const child = spawn(process.execPath, [join(root, "dist", "index.js"), "--no-open", "--no-watch", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15000);
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ origin: match[0], port: Number(match[1]) });
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${output}`)));
  });

  return {
    ...url,
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    },
  };
}

test("The server answers only requests addressed to localhost", async (t) => {
  const server = await startServer(["-p", "0"]);
  t.after(() => server.stop());

  // node:http rather than fetch: fetch treats Host as a forbidden header and
  // rewrites it from the URL, so a rebinding request cannot be expressed.
  const status = (path, host = `127.0.0.1:${server.port}`) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, method: "GET", headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.once("error", reject);
      req.end();
    });

  // The names the server is genuinely reachable under.
  assert.equal(await status("/"), 200);
  assert.equal(await status("/", `localhost:${server.port}`), 200);
  assert.equal(await status("/", `[::1]:${server.port}`), 200);

  // A rebinding page arrives with its own hostname in the Host header. Every
  // route is gated, not only the editor page.
  const rebind = `rebind.attacker.test:${server.port}`;
  assert.equal(await status("/", rebind), 403);
  assert.equal(await status("/__preview", rebind), 403);
  assert.equal(await status("/package.json", rebind), 403);

  // A right name on the wrong port is not this server either.
  assert.equal(await status("/", "127.0.0.1"), 403);
  assert.equal(await status("/", `127.0.0.1:${server.port + 1}`), 403);
});
