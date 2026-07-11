import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createConsoleAssetsHandler } from "../src/console-assets.js";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("serves a dependency-free console with strict static headers", async (t) => {
  const server = await listen(createConsoleAssetsHandler());
  t.after(server.close);

  const page = await fetch(`${server.baseUrl}/channel-gateway`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  const pageBody = await page.text();
  assert.match(pageBody, /互通房间/);
  assert.match(pageBody, /所有 OpenClaw Channel/);
  assert.match(pageBody, /channels\/whatsapp/);
  assert.match(pageBody, /channels\/wechat/);

  const app = await fetch(`${server.baseUrl}/channel-gateway/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get("content-type"), /text\/javascript/);
  assert.match(await app.text(), /links\/config/);
  assert.equal((await fetch(`${server.baseUrl}/channel-gateway/unknown`)).status, 404);
});
