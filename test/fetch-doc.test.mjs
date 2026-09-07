import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { safeFetch, BlockedAddressError } from "../dist/safe-fetch.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Starts the CLI and resolves once it prints the URL it serves. */
async function startServer() {
  const child = spawn(
    process.execPath,
    [join(root, "dist", "index.js"), "--no-open", "--no-watch", "-p", "0"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
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
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    },
  };
}

/** A throwaway upstream the fetcher is pointed at. */
async function upstream(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      server.close();
      await once(server, "close").catch(() => {});
    },
  };
}

test("safeFetch refuses to connect to private addresses", async (t) => {
  const secret = await upstream((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SUPER_SECRET_TOKEN=hunter2\n");
  });
  t.after(() => secret.stop());

  await assert.rejects(
    () => safeFetch(`${secret.origin}/secret.txt`, { maxBytes: 1024 }),
    BlockedAddressError,
    "loopback is refused"
  );

  for (const target of [
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://0.0.0.0/",
  ]) {
    await assert.rejects(() => safeFetch(target, { maxBytes: 1024 }), BlockedAddressError, target);
  }
});

test("safeFetch re-checks every redirect hop", async (t) => {
  const secret = await upstream((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SUPER_SECRET_TOKEN=hunter2\n");
  });
  t.after(() => secret.stop());

  // A redirect is how a public URL reaches a private one; the hop is checked
  // rather than followed by the client.
  const hop = await upstream((_req, res) => {
    res.writeHead(302, { Location: `${secret.origin}/secret.txt` });
    res.end();
  });
  t.after(() => hop.stop());

  await assert.rejects(
    () => safeFetch(hop.origin, { maxBytes: 1024 }),
    BlockedAddressError,
    "the redirect target is checked too"
  );
});

test("POST /__fetch-doc will not proxy a loopback URL", async (t) => {
  const secret = await upstream((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SUPER_SECRET_TOKEN=hunter2\n");
  });
  t.after(() => secret.stop());

  const server = await startServer();
  t.after(() => server.stop());

  const post = (body) =>
    new Promise((resolve, reject) => {
      const url = new URL(`${server.origin}/__fetch-doc`);
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "text/plain" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => (text += chunk));
          res.once("end", () => resolve({ status: res.statusCode, text }));
        }
      );
      req.once("error", reject);
      req.end(body);
    });

  const blocked = await post(JSON.stringify({ url: `${secret.origin}/secret.txt` }));
  assert.equal(blocked.status, 403);
  assert.ok(!blocked.text.includes("hunter2"), "the body never reaches the caller");
});
