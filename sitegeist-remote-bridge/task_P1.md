# P1：开发计划与验收标准

在 **P0（鉴权 + 长连接）** 之上，定义并实现 **v1 应用层信封**：`v`、`cmd`、可选 `id` / `sessionId` / `payload`。P1 桥侧实现 **`ping` → `ack`**；可选 **`echo`** 便于脚本自测。**不**实现 `append_user_and_run`、不转发 sidepanel、不改会话（P2/P3）。

---

## 1. 范围边界

| 纳入 P1 | 不纳入 P1 |
|---------|-----------|
| 鉴权成功后，**仅接受 JSON 文本帧**作为应用消息（非 JSON → 错误信封，默认不关连接） | 仍接受任意纯文本当业务帧（P0 行为） |
| 信封字段 **`v`**（整数）、**`cmd`**（字符串）、可选 **`id`**、**`sessionId`**、**`payload`** | `cmd: "append_user_and_run"` 及 Agent 执行 |
| **`cmd: "ping"`** → 桥回复 **`type: "ack"`**（见 §2） | 多客户端广播、房间 |
| **`cmd: "echo"`**（可选）→ 桥在 ack 中带回 `payload`，供 wscat/脚本测通 | Pi 扩展 `registerTool`（P3） |
| **Sitegeist background**：`auth_ok` 后发送 **`ping`**，收到 **ack** 可 `console` 观测 | sidepanel 订阅桥消息 |

---

## 2. 协议 v1（鉴权成功后）

### 2.1 请求（客户端 → 桥）

```json
{
  "v": 1,
  "cmd": "ping",
  "id": "可选，原样回到响应",
  "sessionId": "可选，P1 仅透传回 ack，不做路由",
  "payload": {}
}
```

- **`v`**：必须为 **1**；否则 `type: "error"`，`error: "bad_version"`。  
- **`cmd`**：P1 支持 **`ping`**、**`echo`**；其它命令 → `unknown_cmd`。  
- **`echo`**：`payload` 应为对象，且含任意 **`body`**（由桥在 ack 的 `payload` 中原样返回）；缺省时 `body` 视为 `null`。

### 2.2 成功响应（桥 → 客户端）

```json
{
  "v": 1,
  "type": "ack",
  "id": "<请求 id 或省略>",
  "cmd": "ping",
  "ok": true,
  "sessionId": "<请求 sessionId 或省略>",
  "payload": {}
}
```

- **`ping`**：`payload` 可为 **`{ "pong": true }`** 或空对象（实现选一种并写死文档）。  
- **`echo`**：`payload` 为 **`{ "body": <请求 payload.body> }`**。

### 2.3 错误响应

```json
{
  "v": 1,
  "type": "error",
  "id": "<请求 id 或省略>",
  "ok": false,
  "error": "bad_json | bad_version | missing_cmd | unknown_cmd | ...",
  "detail": "可选人类可读说明"
}
```

- **非 JSON** 文本：`error: "bad_json"`。  
- **缺 `cmd`**：`missing_cmd`。

### 2.4 与 P0 的兼容

- 鉴权首帧不变：`{"type":"auth","token":"..."}`。  
- 鉴权成功后 **不再** 对任意字符串做 P0 式 `echo`；统一走 v1 信封（`echo` 命令用于调试回显）。

---

## 3. 开发任务（建议顺序）

1. **`src/remote-bridge-protocol.ts`（新建）**  
   - 常量：`REMOTE_BRIDGE_PROTOCOL_V1 = 1`。  
   - TypeScript 类型：`RemoteBridgeV1Request`、`RemoteBridgeV1Ack`、`RemoteBridgeV1Error`（或等价 interface）。  
   - 纯类型 + 常量，避免在 `sitegeist-bridge.mjs` 里维护两份复杂逻辑时可只共享版本号；**桥内校验逻辑**仍以 `.mjs` 实现为准。

2. **`scripts/sitegeist-bridge.mjs`**  
   - `authenticated` 后：对每个文本帧 `JSON.parse`，按 §2 分支 **`ping` / `echo` / error**。  
   - stderr 可打简短行（如 `unknown_cmd: foo`），**不必**因业务错误自动断开 TCP。

3. **`src/remote-bridge-client.ts`**  
   - `auth_ok` 后发送 **`{ v:1, cmd:"ping", id: "..." }`**（不再发送 `bridge_hello`）。  
   - `onmessage`：解析 JSON；若为 **`type:"ack"`** 且 **`cmd:"ping"`**，打一条 **`[RemoteBridge] ping ack`**（或带 `id`）。  
   - 对 **`type:"error"`** 打 **`console.warn`**。

4. **更新 `task_P0.md` §6.3**（或仅在 `task_P1.md` §6）说明 wscat 在 auth 后应发 **ping** 信封。

---

## 4. 验收标准（必须全部满足）

### 4.1 桥（Node）

- [ ] **P1-B1** `{"v":1,"cmd":"ping","id":"x"}` → 收到 JSON，`type` 为 **`ack`**，`cmd` 为 **`ping`**，`ok === true`，**`id` 与请求一致**。  
- [ ] **P1-B2** `{"v":2,"cmd":"ping"}` → `type:error`，`error` 含 **`bad_version`**（或文档约定字段）。  
- [ ] **P1-B3** 缺 `cmd` → `missing_cmd`。  
- [ ] **P1-B4** `{"v":1,"cmd":"noop_unknown"}` → `unknown_cmd`，`detail`/`error` 可辨。  
- [ ] **P1-B5** `{"v":1,"cmd":"echo","payload":{"body":{"a":1}}}` → ack 中 **`payload.body` 深等于** 请求（或 JSON 字符串一致）。  
- [ ] **P1-B6** 鉴权后发送非 JSON 字符串 → **`bad_json`**，连接仍保持（除非实现另有说明）。

### 4.2 Sitegeist（扩展）

- [ ] **P1-S1** `auth_ok` 后自动发 **ping**，控制台可见 **ack**（含 `ping` / `ok`）。  
- [ ] **P1-S2** 收到 **`type:error`** 时有 **warn** 级日志（可用错误桥故意测）。

### 4.3 整体验收

- [ ] **P1-E1** 仅用 Node `ws` 客户端：**auth → ping → ack** 脚本可跑通（不加载扩展）。  
- [ ] **P1-E2** `npm run build` 无新增错误。

---

## 5. P1 完成定义（DoD）

- **P1-B1–B6、P1-S1–S2、P1-E1–E2** 全部满足。  
- **`plan.md`** 中「协议草案」与实现一致处已核对（或 `plan` 指向本文件 §2）。  

---

## 6. 联调备忘

### 6.1 启动桥

见 **`task_P0.md` §6.1**（`SITEGEIST_BRIDGE_TOKEN` + `npm run bridge`）。

### 6.2 自动化脚本（推荐）

终端 1：`SITEGEIST_BRIDGE_TOKEN=t npm run bridge`  
终端 2：`SITEGEIST_BRIDGE_TOKEN=t npm run test:bridge-p1`  

应打印 `test-remote-bridge-p1: OK` 并以退出码 **0** 结束。

### 6.3 wscat

```text
{"type":"auth","token":"<SITEGEIST_BRIDGE_TOKEN>"}
{"v":1,"cmd":"ping","id":"wscat-1"}
```

第二行应收到 **`type":"ack"`** 且 **`cmd":"ping"`**。

### 6.4 扩展

`sitegeistRemoteBridge` 配置同 P0；Reload 后 Service worker 控制台应出现 **`[RemoteBridge] ping ack`**。
