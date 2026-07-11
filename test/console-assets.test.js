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
  assert.match(pageBody, /id="delivery-concurrency-auto"/);
  assert.match(pageBody, /id="delivery-concurrency"/);
  assert.match(pageBody, /id="resource-summary"/);
  assert.match(pageBody, /id="delivery-health"/);
  assert.match(pageBody, /id="delivery-accounts"/);

  const app = await fetch(`${server.baseUrl}/channel-gateway/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get("content-type"), /text\/javascript/);
  const appBody = await app.text();
  assert.match(appBody, /links\/config/);
  assert.match(appBody, /\["whatsapp", "WhatsApp"/);
  assert.match(appBody, /\["wechat", "WeChat"/);
  assert.match(appBody, /effectiveDeliveryMaxConcurrency/);
  assert.match(appBody, /deliveryMaxConcurrencyAutoMax/);
  assert.match(appBody, /deliveryMaxConcurrency:/);
  assert.match(appBody, /deliveryConcurrencyValue/);
  assert.match(appBody, /delivery\/status/);
  assert.match(appBody, /renderDeliveryHealth/);
  assert.equal((await fetch(`${server.baseUrl}/channel-gateway/unknown`)).status, 404);
});

test("ships a per-channel integration console rather than a static channel list", async (t) => {
  const server = await listen(createConsoleAssetsHandler());
  t.after(server.close);

  const page = await (await fetch(`${server.baseUrl}/channel-gateway`)).text();
  const app = await (await fetch(`${server.baseUrl}/channel-gateway/app.js`)).text();
  assert.match(page, /id="channel-cards"/);
  assert.match(app, /const CHANNELS =/);
  assert.match(app, /\["telegram", "Telegram"/);
  assert.match(app, /\["wechat", "WeChat"/);
  assert.match(app, /channels\/\$\{channel\.id\}\/\$\{action\}/);
  assert.match(app, /添加到互通房间/);
});
