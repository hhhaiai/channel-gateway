const $ = (selector) => document.querySelector(selector);
const state = { token: "", links: [], revision: null };
const blankEndpoint = () => ({ id: "", channel: "telegram", accountId: "default", conversationId: "", to: "", receive: true, send: true, threadId: null });
const blankRoom = () => ({ id: "", endpoints: [blankEndpoint(), blankEndpoint()] });

function notice(message, error = false) { const out = $("#notice"); out.textContent = message; out.style.color = error ? "#b42318" : "#12723a"; }
async function api(path, options = {}) {
  if (!state.token) throw new Error("请先输入 Gateway Token 并连接");
  const response = await fetch(`/api/v1${path}`, { ...options, headers: { authorization: `Bearer ${state.token}`, ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error?.code ?? `HTTP ${response.status}`);
  return payload.result;
}
function field(value, type, room, endpoint, key) { const input = document.createElement(type === "boolean" ? "input" : "input"); input.type = type === "boolean" ? "checkbox" : "text"; input.value = type === "boolean" ? "" : (value ?? ""); input.checked = type === "boolean" ? Boolean(value) : false; input.dataset.room = room; input.dataset.endpoint = endpoint; input.dataset.key = key; input.addEventListener("change", edit); return input; }
function edit(event) { const el = event.target; const endpoint = state.links[Number(el.dataset.room)].endpoints[Number(el.dataset.endpoint)]; endpoint[el.dataset.key] = el.type === "checkbox" ? el.checked : el.value; }
function renderRooms() {
  const root = $("#rooms"); root.replaceChildren();
  state.links.forEach((room, roomIndex) => {
    const block = document.createElement("section"); block.className = "room";
    const title = document.createElement("div"); title.textContent = "房间 ID ";
    const id = document.createElement("input"); id.value = room.id; id.addEventListener("change", (e) => { room.id = e.target.value; }); title.append(id);
    const removeRoom = document.createElement("button"); removeRoom.textContent = "删除房间"; removeRoom.onclick = () => { state.links.splice(roomIndex, 1); renderRooms(); }; title.append(" ", removeRoom); block.append(title);
    room.endpoints.forEach((endpoint, endpointIndex) => {
      const row = document.createElement("div"); row.className = "row";
      for (const [label, key, kind] of [["endpoint ID","id","text"],["channel","channel","text"],["account","accountId","text"],["群 conversationId","conversationId","text"],["发送 to","to","text"],["收","receive","boolean"],["发","send","boolean"]]) { const labelEl = document.createElement("label"); labelEl.textContent = `${label} `; labelEl.append(field(endpoint[key], kind, roomIndex, endpointIndex, key)); row.append(labelEl); }
      const remove = document.createElement("button"); remove.textContent = "删除"; remove.onclick = () => { room.endpoints.splice(endpointIndex, 1); renderRooms(); }; row.append(remove); block.append(row);
    });
    const add = document.createElement("button"); add.textContent = "+ 添加群 endpoint"; add.onclick = () => { room.endpoints.push(blankEndpoint()); renderRooms(); }; block.append(add); root.append(block);
  });
}
function renderChannels(value) { const root = $("#channels"); root.replaceChildren(); const pre = document.createElement("pre"); pre.textContent = JSON.stringify(value, null, 2); root.append(pre); }
async function refresh() { state.token = $("#token").value.trim(); const [config, channels] = await Promise.all([api("/links/config"), api("/channels?probe=true")]); state.links = config.links; state.revision = config.revision; renderRooms(); renderChannels(channels); notice("已加载；Token 未写入本地存储。"); }
$("#connect").onclick = () => refresh().catch((e) => notice(e.message, true));
$("#add-room").onclick = () => { state.links.push(blankRoom()); renderRooms(); };
$("#save").onclick = async () => { try { const result = await api("/links/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ links: state.links, revision: state.revision }) }); state.links = result.links; state.revision = result.revision; renderRooms(); notice("已保存到 OpenClaw 配置。请重启 channel-gateway 后生效。"); } catch (e) { notice(e.message === "CONFIG_CONFLICT" ? "配置已被其他管理员修改，请重新连接后再保存。" : e.message, true); } };
