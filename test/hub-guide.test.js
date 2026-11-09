import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

test("Hub guidance shares the product chat endpoint behind authentication", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hub-guide-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guidePath = path.join(directory, "guide.md");
  const fixture = "Operations → Example Stock → Example Lookup";
  await writeFile(guidePath, fixture);

  let payload;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "Fixture reply" }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());

  const env = {
    ...process.env,
    PORT: "0",
    ANTHROPIC_API_KEY: "fixture",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    HUB_GUIDE_PATH: guidePath,
    BASIC_AUTH_USER: "fixture",
    BASIC_AUTH_PASS: "fixture-password"
  };
  const rejected = spawn(process.execPath, ["server.js"], {
    env: { ...env, BASIC_AUTH_PASS: "" }
  });
  assert.deepEqual(await once(rejected, "exit"), [1, null]);

  const app = spawn(process.execPath, ["server.js"], { env });
  t.after(() => app.kill());
  const url = await new Promise((resolve, reject) => {
    let output = "";
    app.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    app.once("error", reject);
    app.once("exit", (code) => reject(new Error(`App exited with code ${code}`)));
  });

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}/api/capabilities`)).status, 401);
  assert.equal((await fetch(`${url}/api/chat`, { method: "POST" })).status, 401);
  const authorization = "Basic " + Buffer.from("fixture:fixture-password").toString("base64");
  const capabilities = await fetch(`${url}/api/capabilities`, { headers: { authorization } });
  assert.deepEqual(await capabilities.json(), { hubGuide: true });

  const message = "Where can I look up inbound stock, and how do I clean a HoverMatt?";
  const response = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "Fixture reply" });
  assert.ok(payload.system.some(({ text }) => text.includes(fixture)));
  assert.ok(payload.system.some(({ text }) => text.includes("hovermatt-usage-and-ifu.md")));
  assert.deepEqual(payload.messages.at(-1), { role: "user", content: message });
});
