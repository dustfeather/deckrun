import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Starts the CLI in `cwd` and resolves once it prints the URL it serves. */
async function startServer(cwd) {
  const child = spawn(
    process.execPath,
    [join(root, "dist", "index.js"), "--no-open", "--no-watch", "-p", "0"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  );

  let output = "";
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15000);
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${output}`)));
  });

  return {
    origin,
    port: Number(/:(\d+)$/.exec(origin)[1]),
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    },
  };
}

test("The static route serves deck assets and nothing else", async (t) => {
  // A blank editor started from a directory that also holds private files —
  // the documented way to open deckrun, and for many people that is $HOME.
  const dir = await mkdtemp(join(tmpdir(), "deckrun-static-"));
  await mkdir(join(dir, ".ssh"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, ".env"), "SUPER_SECRET_TOKEN=hunter2\n");
  await writeFile(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=nope\n");
  await writeFile(join(dir, ".ssh", "id_rsa"), "PRIVATE KEY\n");
  await writeFile(join(dir, "id_rsa"), "PRIVATE KEY\n");
  await writeFile(join(dir, "assets", "diagram.png"), "not really a png");
  await writeFile(join(dir, "deck.md"), "# Deck\n");

  const server = await startServer(dir);
  t.after(() => server.stop());

  // node:http rather than fetch: the URL parser normalizes `..` and `%2e%2e`
  // out of a path before the request is sent, so traversal cannot be tested
  // through fetch at all.
  const status = (path) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.once("error", reject);
      req.end();
    });

  for (const secret of ["/.env", "/.npmrc", "/.ssh/id_rsa", "/id_rsa"]) {
    assert.equal(await status(secret), 403, `${secret} is not served`);
  }

  // Deck assets still resolve, which is the only reason the route exists.
  assert.equal(await status("/assets/diagram.png"), 200);
  assert.equal(await status("/deck.md"), 200);

  // Traversal above the launch directory stays blocked.
  assert.equal(await status("/../package.json"), 403);
  assert.equal(await status("/%2e%2e/package.json"), 403);
});
