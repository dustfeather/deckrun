import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Starts the CLI on a file and resolves once it prints the URL it serves. */
async function startServer(file) {
  const child = spawn(
    process.execPath,
    [join(root, "dist", "index.js"), file, "--no-open", "--no-watch", "-p", "0"],
    { cwd: dirname(file), stdio: ["ignore", "pipe", "pipe"] }
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

  const port = Number(/:(\d+)$/.exec(origin)[1]);
  const call = (path, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (text += chunk));
        res.once("end", () => resolve({ status: res.statusCode, text }));
      });
      req.once("error", reject);
      req.end(body);
    });

  return {
    origin,
    port,
    call,
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    },
  };
}

test("Mutating routes require the session token", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deckrun-csrf-"));
  const deck = join(dir, "deck.md");
  const original = "# Original Deck\n\nSafe content, authored by the user.\n";
  await writeFile(deck, original);

  const server = await startServer(deck);
  t.after(() => server.stop());

  // The token reaches the editor page and nowhere else.
  const page = await server.call("/");
  const token = JSON.parse(
    /<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/.exec(page.text)[1]
  ).token;
  assert.ok(token && token.length >= 24, "the page carries a session token");

  // The exact request from the report: a CORS-simple POST from another site.
  const forged = await server.call("/__file", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: "# PWNED BY evil.example\n",
  });
  assert.equal(forged.status, 403);
  assert.equal(await readFile(deck, "utf-8"), original, "the file on disk is untouched");

  // Without the token but same-origin: still refused.
  const noToken = await server.call("/__file", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "# no token\n",
  });
  assert.equal(noToken.status, 403);
  assert.equal(await readFile(deck, "utf-8"), original);

  // Reads are gated too — /__file GET returns the document.
  assert.equal((await server.call("/__file")).status, 403);

  // With the token, the editor's own save still works.
  const saved = await server.call("/__file", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Deckrun-Token": token },
    body: "# Saved by the editor\n",
  });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(deck, "utf-8"), "# Saved by the editor\n");
});

test("Stashed decks get unguessable ids", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deckrun-stash-"));
  const deck = join(dir, "deck.md");
  await writeFile(deck, "# Deck\n");

  const server = await startServer(deck);
  t.after(() => server.stop());

  const token = JSON.parse(
    /<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/.exec(
      (await server.call("/")).text
    )[1]
  ).token;

  // The attacker's stash attempt is refused outright.
  const forged = await server.call("/__present-doc", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ html: "<img src=x onerror=alert(1)>" }),
  });
  assert.equal(forged.status, 403);

  // And a deck the editor legitimately stashes is not at a guessable id.
  const built = await server.call("/__present-doc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Deckrun-Token": token },
    body: JSON.stringify({ html: "<h1>mine</h1>", title: "mine" }),
  });
  assert.equal(built.status, 200);
  const { docPath } = JSON.parse(built.text);
  assert.match(docPath, /^\/\?deck=[0-9a-f]{32}$/, "the id is random, not a counter");

  for (const guess of ["1", "2", "3", "8"]) {
    assert.equal((await server.call(`/?deck=${guess}`)).status, 410, `?deck=${guess} is not a deck`);
  }
  assert.equal((await server.call(docPath)).status, 200);
});
