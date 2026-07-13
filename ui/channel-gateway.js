const $ = (selector) => document.querySelector(selector);
const state = {
  token: "",
  links: [],
  revision: null,
  channelStatus: null,
  configuration: null,
  deliveryStatus: null,
};
const ENDPOINT_FIELDS = [
  ["endpoint ID", "id", "text"], ["channel", "channel", "text"], ["account", "accountId", "text"],
  ["会话 conversationId", "conversationId", "text"], ["发送 to", "to", "text"],
  ["收", "receive", "boolean"], ["发", "send", "boolean"],
];
const CHANNELS = [
  ["discord", "Discord", "official"], ["feishu", "Feishu / Lark", "official"], ["googlechat", "Google Chat", "official"],
  ["imessage", "iMessage", "core"], ["irc", "IRC", "official"], ["line", "LINE", "official"],
  ["matrix", "Matrix", "official"], ["mattermost", "Mattermost", "official"], ["msteams", "Microsoft Teams", "official"],
  ["nextcloud-talk", "Nextcloud Talk", "official"], ["nostr", "Nostr", "official"], ["qqbot", "QQ Bot", "official"],
  ["raft", "Raft", "official"], ["signal", "Signal", "official"], ["slack", "Slack", "official"], ["sms", "SMS", "official"],
  ["synology-chat", "Synology Chat", "official"], ["telegram", "Telegram", "core"], ["tlon", "Tlon", "official"],
  ["twitch", "Twitch", "official"], ["webchat", "WebChat", "core", "/web/webchat"],
  ["openclaw-weixin", "WeChat 私聊", "external", "/channels/wechat"],
  ["wecom", "企业微信群", "partner", "https://github.com/WecomTeam/wecom-openclaw-plugin"],
  ["whatsapp", "WhatsApp", "official"], ["yuanbao", "Yuanbao", "external"], ["zalo", "Zalo", "official"],
  ["zaloclawbot", "Zalo ClawBot", "external"], ["zalouser", "Zalo Personal", "official"],
  ["voice-call", "Voice Call", "plugin", "/plugins/voice-call"],
].map(([id, name, kind, docPath = `/channels/${id}`]) => ({ id, name, kind, docPath }));

const blankEndpoint = (channel = "telegram") => ({
  id: "", channel, accountId: "default", conversationId: "", to: "", receive: true, send: true,
});
const blankRoom = (channel) => ({ id: "", endpoints: [blankEndpoint(channel), blankEndpoint()] });

function notice(message, error = false) {
  const out = $("#notice");
  out.textContent = message;
  out.style.color = error ? "#b42318" : "#12723a";
}

async function api(path, options = {}) {
  if (!state.token) throw new Error("请先输入 Gateway Token 并连接");
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: { authorization: `Bearer ${state.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error?.code ?? `HTTP ${response.status}`);
  return payload.result;
}

function statusEntries(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.channels)) return value.channels;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function statusFor(channel) {
  const entry = statusEntries(state.channelStatus).find((value) =>
    [value?.id, value?.channel, value?.channelId].includes(channel.id));
  if (entry) return JSON.stringify(entry);
  return state.channelStatus ? "Gateway 未报告此 Channel；可能尚未安装或未配置。" : "连接后查询。";
}

function field(value, type, room, endpoint, key) {
  const input = document.createElement("input");
  input.type = type === "boolean" ? "checkbox" : "text";
  if (type === "boolean") input.checked = Boolean(value);
  else input.value = value ?? "";
  input.dataset.room = room;
  input.dataset.endpoint = endpoint;
  input.dataset.key = key;
  input.addEventListener("change", editEndpoint);
  return input;
}

function editEndpoint(event) {
  const input = event.target;
  const endpoint = state.links[Number(input.dataset.room)].endpoints[Number(input.dataset.endpoint)];
  endpoint[input.dataset.key] = input.type === "checkbox" ? input.checked : input.value;
}

function renderRooms() {
  const root = $("#rooms");
  root.replaceChildren();
  state.links.forEach((room, roomIndex) => {
    const block = document.createElement("section");
    block.className = "room";
    const title = document.createElement("div");
    title.textContent = "房间 ID ";
    const id = document.createElement("input");
    id.value = room.id;
    id.addEventListener("change", (event) => { room.id = event.target.value; });
    title.append(id);
    const removeRoom = document.createElement("button");
    removeRoom.textContent = "删除房间";
    removeRoom.onclick = () => { state.links.splice(roomIndex, 1); renderRooms(); };
    title.append(" ", removeRoom);
    block.append(title);

    room.endpoints.forEach((endpoint, endpointIndex) => {
      const row = document.createElement("div");
      row.className = "row";
      for (const [label, key, type] of ENDPOINT_FIELDS) {
        const labelEl = document.createElement("label");
        labelEl.textContent = `${label} `;
        labelEl.append(field(endpoint[key], type, roomIndex, endpointIndex, key));
        row.append(labelEl);
      }
      const remove = document.createElement("button");
      remove.textContent = "删除";
      remove.onclick = () => { room.endpoints.splice(endpointIndex, 1); renderRooms(); };
      row.append(remove);
      block.append(row);
    });

    const add = document.createElement("button");
    add.textContent = "+ 添加 endpoint";
    add.onclick = () => { room.endpoints.push(blankEndpoint()); renderRooms(); };
    block.append(add);
    root.append(block);
  });
}

function addEndpointForChannel(channel) {
  if (state.links.length === 0) state.links.push(blankRoom(channel.id));
  else state.links[0].endpoints.push(blankEndpoint(channel.id));
  renderRooms();
  notice(`${channel.name} endpoint 已加入第一个互通房间；请填写 conversationId 与 to。`);
}

async function lifecycle(channel, action) {
  try {
    await api(`/channels/${channel.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "default" }),
    });
    notice(`${channel.name} 已请求 ${action}。`);
    await refresh();
  } catch (error) {
    notice(`${channel.name}: ${error.message}`, true);
  }
}

function renderChannelCards() {
  const root = $("#channel-cards");
  root.replaceChildren();
  for (const channel of CHANNELS) {
    const card = document.createElement("article");
    card.className = "channel-card";
    const heading = document.createElement("h3");
    heading.textContent = channel.name;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = channel.kind === "core"
      ? "core"
      : channel.kind === "official"
        ? "official plugin"
        : channel.kind === "partner" ? "platform official" : channel.kind;
    heading.append(" ", badge);
    card.append(heading);

    const guide = document.createElement("p");
    guide.className = "muted";
    guide.textContent = channel.kind === "core"
      ? "Core Channel：按官方页面配置后即可使用。"
      : channel.kind === "partner"
        ? "平台官方插件：使用 all/common profile 时固定安装并自动发现；base profile 不安装。"
      : channel.kind === "external"
        ? "外置 Channel：按官方页面安装，并通过 CHANNEL_GATEWAY_PLUGIN_PATHS 加载绝对路径。"
        : channel.kind === "plugin"
          ? "官方插件资料：不声明通用 Channel endpoint，不能加入 links。"
          : "官方插件：使用 all profile 安装，再按官方页面执行 channels add/login。";
    card.append(guide);

    const docs = document.createElement("a");
    docs.href = channel.docPath.startsWith("https://")
      ? channel.docPath
      : `https://docs.openclaw.ai${channel.docPath}`;
    docs.target = "_blank";
    docs.rel = "noreferrer";
    docs.textContent = "打开官方集成文档";
    card.append(docs);

    const status = document.createElement("pre");
    status.className = "channel-status";
    status.textContent = statusFor(channel);
    card.append(status);

    if (channel.kind !== "plugin") {
      const actions = document.createElement("div");
      actions.className = "actions";
      for (const action of ["start", "stop", "logout"]) {
        const button = document.createElement("button");
        button.textContent = action;
        button.onclick = () => lifecycle(channel, action);
        actions.append(button);
      }
      const add = document.createElement("button");
      add.textContent = "添加到互通房间";
      add.onclick = () => addEndpointForChannel(channel);
      actions.append(add);
      card.append(actions);
    }
    root.append(card);
  }
}

function renderChannels(value) {
  const root = $("#channels");
  root.replaceChildren();
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2);
  root.append(pre);
}

function formatBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1) return "unknown";
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function renderResourceSettings(configuration) {
  state.configuration = configuration;
  const automatic = configuration.deliveryMaxConcurrency === null;
  const auto = $("#delivery-concurrency-auto");
  const input = $("#delivery-concurrency");
  auto.checked = automatic;
  input.disabled = automatic;
  input.max = String(configuration.deliveryMaxConcurrencyHardMax);
  input.value = String(
    automatic
      ? configuration.effectiveDeliveryMaxConcurrency
      : configuration.deliveryMaxConcurrency,
  );
  const source = {
    config: "持久化配置",
    environment: "环境变量",
    detected: "资源自动探测",
  }[configuration.deliveryMaxConcurrencySource] ?? configuration.deliveryMaxConcurrencySource;
  $("#resource-summary").textContent = [
    `当前有效并发 ${configuration.effectiveDeliveryMaxConcurrency}`,
    `来源 ${source}`,
    `SQLite 自动上限 ${configuration.deliveryMaxConcurrencyAutoMax}`,
    `CPU ${configuration.resources.cpuCount}`,
    `内存上限 ${formatBytes(configuration.resources.memoryLimitBytes)}`,
    `内存来源 ${configuration.resources.memorySource}`,
  ].join("；");
}

function statusLabel(status) {
  return {
    healthy: "正常",
    recovering: "恢复中",
    degraded: "异常（可重试）",
    unavailable: "不可用",
  }[status] ?? status ?? "未知";
}

function timeLabel(value) {
  return Number.isSafeInteger(value) ? new Date(value).toLocaleString() : "—";
}

function appendCell(row, value, className) {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
}

function renderDeliveryHealth(value) {
  state.deliveryStatus = value;
  const channels = Array.isArray(value?.channels) ? value.channels : [];
  const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
  const limits = new Map((Array.isArray(value?.rateLimits) ? value.rateLimits : []).map((item) => [
    JSON.stringify([item.channel, item.accountId]), item,
  ]));

  const channelRoot = $("#delivery-channels");
  channelRoot.replaceChildren();
  if (channels.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "当前没有投递账号数据。";
    channelRoot.append(empty);
  } else {
    for (const channel of channels) {
      const card = document.createElement("article");
      card.className = `health-card status-${channel.status}`;
      const title = document.createElement("strong");
      title.textContent = `${channel.channel} · ${statusLabel(channel.status)}`;
      const summary = document.createElement("span");
      summary.textContent = `${channel.accounts} 个账号；等待 ${channel.pending}；发送中 ${channel.sending}；失败 ${channel.failed}`;
      card.append(title, summary);
      channelRoot.append(card);
    }
  }

  const accountRoot = $("#delivery-accounts");
  accountRoot.replaceChildren();
  if (accounts.length === 0) {
    const row = document.createElement("tr");
    appendCell(row, "当前没有投递账号数据。", "muted empty-row");
    row.firstChild.colSpan = 7;
    accountRoot.append(row);
    return;
  }
  for (const account of accounts) {
    const limit = limits.get(JSON.stringify([account.channel, account.accountId]));
    const row = document.createElement("tr");
    appendCell(row, `${account.channel} / ${account.accountId}`);
    appendCell(row, statusLabel(account.status), `status-text status-${account.status}`);
    appendCell(row, account.errorCode ?? "—");
    appendCell(row, `等待 ${account.pending} / 发送中 ${account.sending} / 失败 ${account.failed}`);
    appendCell(row, timeLabel(account.nextRetryAtMs));
    appendCell(row, limit
      ? `${limit.ratePerSecond}/s；${limit.tokens}/${limit.burst}`
      : "尚无活动采样");
    appendCell(row, limit?.blockedUntilMs ? timeLabel(limit.blockedUntilMs) : "—");
    accountRoot.append(row);
  }
}

function deliveryConcurrencyValue() {
  if ($("#delivery-concurrency-auto").checked) return null;
  const value = Number($("#delivery-concurrency").value);
  const maximum = state.configuration.deliveryMaxConcurrencyHardMax;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`最大并发投递必须是 1 到 ${maximum} 的整数`);
  }
  return value;
}

async function refresh() {
  state.token = $("#token").value.trim();
  const [config, channels, delivery] = await Promise.all([
    api("/links/config"),
    api("/channels?probe=true"),
    api("/delivery/status"),
  ]);
  state.links = config.links;
  state.revision = config.revision;
  state.channelStatus = channels;
  renderResourceSettings(config);
  renderDeliveryHealth(delivery);
  renderRooms();
  renderChannels(channels);
  renderChannelCards();
  notice("已加载；Token 未写入本地存储。");
}

$("#connect").onclick = () => refresh().catch((error) => notice(error.message, true));
$("#add-room").onclick = () => { state.links.push(blankRoom()); renderRooms(); };
$("#delivery-concurrency-auto").onchange = (event) => {
  const input = $("#delivery-concurrency");
  input.disabled = event.target.checked;
  if (event.target.checked && state.configuration) {
    input.value = String(state.configuration.effectiveDeliveryMaxConcurrency);
  }
};
$("#save").onclick = async () => {
  try {
    const result = await api("/links/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        links: state.links,
        revision: state.revision,
        deliveryMaxConcurrency: deliveryConcurrencyValue(),
      }),
    });
    state.links = result.links;
    state.revision = result.revision;
    renderResourceSettings(result);
    renderRooms();
    notice("已保存到 OpenClaw 配置。请重启 channel-gateway 后生效。");
  } catch (error) {
    notice(error.message === "CONFIG_CONFLICT" ? "配置已被其他管理员修改，请重新连接后再保存。" : error.message, true);
  }
};

renderChannelCards();
