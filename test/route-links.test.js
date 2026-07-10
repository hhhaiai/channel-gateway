import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  appendBridgeMarker,
  compileLinks,
  matchSourceEndpoints,
  planFanout,
  stripBridgeMarker,
} from "../src/route-links.js";

const EVENT = {
  id: "evt_source",
  channel: "qqbot",
  accountId: "default",
  conversationId: "qq-group-1",
  messageId: "qq-message-1",
  sender: { id: "u1", name: "Alice", username: null },
  text: "hello",
  threadId: null,
  replyTo: null,
  media: [],
  isGroup: true,
  metadata: {},
  receivedAt: "2026-07-10T00:00:00.000Z",
};

const LINK_INPUT = [
  {
    id: "ops-room",
    endpoints: [
      {
        id: "qq",
        channel: "qqbot",
        conversationId: "qq-group-1",
        to: "qq-group-1",
      },
      {
        id: "feishu",
        channel: "feishu",
        conversationId: "oc_chat",
        to: "oc_chat",
      },
      {
        id: "wa",
        channel: "whatsapp",
        conversationId: "120@g.us",
        to: "120@g.us",
      },
      {
        id: "tg",
        channel: "telegram",
        conversationId: "-1001",
        to: "-1001",
      },
    ],
  },
];

function deliveryId(destinationEndpointId) {
  return `dlv_${createHash("sha256")
    .update(`v1|${EVENT.id}|ops-room|${destinationEndpointId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

test("fans one QQ group message out to Feishu, WhatsApp, and Telegram generically", () => {
  const input = structuredClone(LINK_INPUT);
  const snapshot = structuredClone(input);
  const links = compileLinks(input);

  const jobs = planFanout({ event: EVENT, links });

  assert.deepEqual(
    jobs.map((job) => job.destinationEndpointId),
    ["feishu", "wa", "tg"],
  );
  assert.deepEqual(
    jobs.map((job) => job.id),
    [deliveryId("feishu"), deliveryId("wa"), deliveryId("tg")],
  );
  assert.equal(jobs.every((job) => job.idempotencyKey === job.id), true);
  assert.equal(jobs[0].request.message.startsWith("[qqbot/Alice] hello"), true);
  assert.equal(Object.hasOwn(jobs[0].request, "replyToId"), false);
  assert.equal(Object.hasOwn(jobs[0].request, "threadId"), false);
  assert.deepEqual(stripBridgeMarker(jobs[0].request.message), {
    text: "[qqbot/Alice] hello",
    deliveryId: jobs[0].id,
  });
  assert.deepEqual(input, snapshot);
});

test("fans Feishu inbound to the same destinations without a platform branch", () => {
  const links = compileLinks(LINK_INPUT);
  const event = {
    ...structuredClone(EVENT),
    id: "evt_feishu",
    channel: "feishu",
    conversationId: "oc_chat",
    sender: { id: "ou_1", name: null, username: "ada" },
  };

  assert.deepEqual(
    planFanout({ event, links }).map((job) => job.destinationChannel),
    ["qqbot", "whatsapp", "telegram"],
  );
});

test("honors receive and send flags and never includes the source endpoint", () => {
  const links = compileLinks([
    {
      id: "flags",
      endpoints: [
        {
          id: "source",
          channel: "telegram",
          conversationId: "chat-a",
          to: "chat-a",
          receive: false,
        },
        {
          id: "disabled-destination",
          channel: "feishu",
          conversationId: "chat-b",
          to: "chat-b",
          send: false,
        },
        {
          id: "enabled",
          channel: "whatsapp",
          conversationId: "chat-c",
          to: "chat-c",
        },
      ],
    },
  ]);
  const telegramEvent = {
    ...EVENT,
    channel: "telegram",
    conversationId: "chat-a",
  };
  assert.deepEqual(matchSourceEndpoints(telegramEvent, links), []);
  assert.deepEqual(planFanout({ event: telegramEvent, links }), []);

  const feishuEvent = {
    ...EVENT,
    channel: "feishu",
    conversationId: "chat-b",
  };
  assert.deepEqual(
    planFanout({ event: feishuEvent, links }).map((job) => job.destinationEndpointId),
    ["source", "enabled"],
  );
});

test("maps media, reply targets, account defaults, and fixed destination threads", () => {
  const links = compileLinks([
    {
      id: "media-room",
      endpoints: [
        {
          id: "source",
          channel: "telegram",
          accountId: "work",
          conversationId: "source-chat",
          to: "source-chat",
        },
        {
          id: "destination",
          channel: "whatsapp",
          conversationId: "destination-chat",
          to: "destination-chat",
          threadId: "fixed-thread",
        },
      ],
    },
  ]);
  const event = {
    ...structuredClone(EVENT),
    id: "evt_media",
    channel: "telegram",
    accountId: "work",
    conversationId: "source-chat",
    text: "",
    sender: { id: "u2", name: null, username: null },
    media: [
      { url: "https://cdn.example/image.png", path: "/tmp/ignored.png", mimeType: "image/png" },
      { url: null, path: "/tmp/audio.ogg", mimeType: "audio/ogg" },
    ],
  };
  const jobs = planFanout({
    event,
    links,
    replyTargets: new Map([["destination", "wa-parent"]]),
  });

  assert.equal(jobs[0].destinationAccountId, "default");
  assert.deepEqual(jobs[0].request.mediaUrls, [
    "https://cdn.example/image.png",
    "/tmp/audio.ogg",
  ]);
  assert.equal(jobs[0].request.replyToId, "wa-parent");
  assert.equal(jobs[0].request.threadId, "fixed-thread");
  assert.equal(stripBridgeMarker(jobs[0].request.message).text, "[telegram/u2]");
});

test("encodes and strips only a valid trailing bridge marker", () => {
  const marked = appendBridgeMarker("visible", "dlv_abc-123");
  assert.deepEqual(stripBridgeMarker(marked), {
    text: "visible",
    deliveryId: "dlv_abc-123",
  });
  assert.deepEqual(stripBridgeMarker(`prefix${marked}suffix`), {
    text: `prefix${marked}suffix`,
    deliveryId: null,
  });
  assert.deepEqual(stripBridgeMarker("visible\u2063cg2:dlv_abc\u2063"), {
    text: "visible\u2063cg2:dlv_abc\u2063",
    deliveryId: null,
  });
  assert.throws(() => appendBridgeMarker("visible", "bad id"), /deliveryId/);
});

test("preserves meaningful message whitespace", () => {
  const links = compileLinks(LINK_INPUT);
  const [job] = planFanout({
    event: { ...EVENT, text: "\n  code block  \n" },
    links,
  });

  assert.equal(
    stripBridgeMarker(job.request.message).text,
    "[qqbot/Alice] \n  code block  \n",
  );
});

test("allows an empty link list so the service can start before routing is configured", () => {
  const links = compileLinks([]);
  assert.deepEqual(matchSourceEndpoints(EVENT, links), []);
  assert.deepEqual(planFanout({ event: EVENT, links }), []);
});

test("rejects ambiguous or incomplete link definitions", () => {
  const validEndpoint = {
    id: "one",
    channel: "telegram",
    conversationId: "chat-one",
    to: "chat-one",
  };
  const cases = [
    {
      input: [{ id: "", endpoints: [validEndpoint, { ...validEndpoint, id: "two" }] }],
      message: /link id/,
    },
    { input: [{ id: "one", endpoints: [validEndpoint] }], message: /at least two endpoints/ },
    {
      input: [
        {
          id: "one",
          endpoints: [validEndpoint, { ...validEndpoint, conversationId: "chat-two" }],
        },
      ],
      message: /endpoint id/,
    },
    {
      input: [
        {
          id: "one",
          endpoints: [validEndpoint, { id: "two", channel: "", conversationId: "chat-two", to: "chat-two" }],
        },
      ],
      message: /channel/,
    },
    {
      input: [
        {
          id: "one",
          endpoints: [validEndpoint, { id: "two", channel: "feishu", conversationId: "", to: "chat-two" }],
        },
      ],
      message: /conversationId/,
    },
    {
      input: [
        {
          id: "one",
          endpoints: [validEndpoint, { id: "two", channel: "feishu", conversationId: "chat-two", to: "" }],
        },
      ],
      message: /to/,
    },
    {
      input: [
        { id: "duplicate", endpoints: [validEndpoint, { id: "two", channel: "feishu", conversationId: "two", to: "two" }] },
        { id: "duplicate", endpoints: [{ id: "three", channel: "whatsapp", conversationId: "three", to: "three" }, { id: "four", channel: "qqbot", conversationId: "four", to: "four" }] },
      ],
      message: /duplicate link id/,
    },
    {
      input: [
        { id: "first", endpoints: [validEndpoint, { id: "two", channel: "feishu", conversationId: "two", to: "two" }] },
        { id: "second", endpoints: [{ ...validEndpoint, id: "three" }, { id: "four", channel: "qqbot", conversationId: "four", to: "four" }] },
      ],
      message: /duplicate endpoint match/,
    },
    {
      input: [
        {
          id: "duplicate-outbound",
          endpoints: [
            validEndpoint,
            { id: "two", channel: "telegram", conversationId: "chat-alias", to: "chat-one" },
          ],
        },
      ],
      message: /duplicate outbound target/,
    },
  ];

  for (const { input, message } of cases) {
    assert.throws(() => compileLinks(input), message);
  }
});
