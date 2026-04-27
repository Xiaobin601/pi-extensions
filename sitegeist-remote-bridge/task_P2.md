# P2：开发计划与验收标准

在 **P1（v1 信封 + `ping`/`ack`）** 之上，实现 **`append_user_and_run`**：CLI（或桥上的第二路连接）下发文本，**仅在「侧栏已加载该 `sessionId` 且本窗口持有锁」** 时，向当前 **Agent** 追加一条 user 消息并触发一次发送。  
**约束**：只动 **`sitegeist-remote-bridge`** 与 **`sitegeist`** 两个模块；**尽量少改已有 `.ts` / `.mjs`**，能新建则新建。

---

## 1. 同 session 规则（与先前方案一致）

1. **单写者**：只有 **当前侧栏实例**（已 `acquireLock(sessionId)` 且内存里 `currentSessionId === 请求 sessionId`）执行 `append_user_and_run`。  
2. **不满足**：通过 **可机读错误码** 返回（如 `session_not_loaded`、`lock_not_held`、`busy`），**不写** IndexedDB、不绕过锁。  
3. **流式中**：首版可对 `isStreaming === true` 返回 **`busy`**（不做队列，降低复杂度）。

---

## 2. 计划修改 / 新建文件（按模块）

### 2.1 **sitegeist**（浏览器扩展 + 本机桥）

| 动作 | 路径 | 说明 |
|------|------|------|
| **改（尽量少行）** | `scripts/sitegeist-bridge.mjs` | 注册 **扩展端 / CLI 端** 连接；将 **`append_user_and_run`** 从 CLI 连接 **转发** 到扩展连接；回 **`ack`/`error`**（带 `id`）。无法省略：桥必须懂路由。 |
| **改（尽量少行）** | `src/remote-bridge-client.ts` | 在现有 `onmessage` 中增加分支：收到 **下行业务帧** → 调新建模块里的 **`dispatchToSidepanel(...)`**（避免在本文件堆逻辑）。 |
| **改（尽量少行）** | `src/sidepanel.ts` | **仅增加一行初始化**：例如 `import { registerRemoteBridgeSidepanel } from "./remote-bridge-sidepanel.js"; registerRemoteBridgeSidepanel(...)`；具体闭包注入在新建文件中完成，**不把大段 handler 写进 sidepanel**。 |
| **新建** | `src/remote-bridge-messages.ts` | **`REMOTE_BRIDGE_*` 常量**、`AppendUserPayload`、**`sendResponse` 形状** 等与 `chrome.runtime` 消息契约。 |
| **新建** | `src/remote-bridge-background-dispatch.ts` | **`chrome.runtime.sendMessage`** 封装；由 **`remote-bridge-client.ts`** 调用；background 不另建入口文件也可。 |
| **新建** | `src/remote-bridge-sidepanel.ts` | **`chrome.runtime.onMessage` 注册**、`sessionId`+锁+`isStreaming` 校验、调用 **`chatPanel.agentInterface.sendMessage`**（或项目内等价 API）；**P2 业务逻辑集中在此文件**。 |
| **新建（可选）** | `scripts/test-remote-bridge-p2.mjs` | 双连接冒烟：CLI 发 `append_user_and_run`，断言桥与扩展侧 ack/error。 |
| **改（可选）** | `package.json` | 增加 **`test:bridge-p2`**。 |
| **不改（首版目标）** | `src/background.ts` | **零 diff**；逻辑留在 `remote-bridge-client` + 新建 dispatch。 |
| **视需要** | `src/remote-bridge-protocol.ts` | **少量**补充 `append_user_and_run` 与错误码类型；避免膨胀可只加 **最小 interface**。 |
| **视需要** | `src/utils/port.ts` | 仅当侧栏无法本地判断锁、必须问 background 时再 **极小扩展** `sendMessage` 类型；**默认不动**。 |

### 2.2 **sitegeist-remote-bridge**（本目录：文档 + 日后 Pi 扩展）

| 动作 | 路径 | 说明 |
|------|------|------|
| **改** | `plan.md` | P2 行链到本文件；文件树可补「P2 新建」引用。 |
| **改** | `CHANGELOG.md` | 记录本模块文档与计划变更（与 `sitegeist/CHANGELOG.md` 同步口径）。 |
| **本文件** | `task_P2.md` | 即本文。 |
| **P3 再动** | `src/index.ts`、`src/bridge-client.ts` 等 | **P2 不实现** Pi `registerTool`。 |

---

## 3. 开发任务（建议顺序）

1. **`remote-bridge-messages.ts`**：消息名与 payload 类型。  
2. **`sitegeist-bridge.mjs`**：双角色连接 + 转发 + 错误路径。  
3. **`remote-bridge-background-dispatch.ts`** + **`remote-bridge-client.ts`** 小改：接到下行 → `sendMessage`。  
4. **`remote-bridge-sidepanel.ts`** + **`sidepanel.ts` 一行**：注册 handler + 校验 + `sendMessage`。  
5. **`test-remote-bridge-p2.mjs`（可选）** + **`package.json`**。  
6. **双 CHANGELOG** + **`plan.md`** 链接。

---

## 4. 验收标准（草案）

- [ ] **P2-B1** 仅扩展连接时，CLI 发 `append_user_and_run` → 桥 **转发** 或明确 **`no_extension_client`**。  
- [ ] **P2-B2** 扩展已连、侧栏满足锁+session 时 → **侧栏出现 user 消息并开始跑**（可见流式或完成）。  
- [ ] **P2-B3** `sessionId` 不匹配 / 无锁 → **错误码** 回到 CLI，且扩展 **未改** 会话存储。  
- [ ] **P2-B4** `isStreaming` 时 → **`busy`**（若实现）。  
- [ ] **P2-E1** `npm run build` 通过；**已有单测不破坏**。

---

## 5. DoD

- 上表 **§2** 所列文件均已落地或明确为「未做（可选）」。  
- **`sitegeist/CHANGELOG.md`** 与 **`sitegeist-remote-bridge/CHANGELOG.md`** `[Unreleased]` 已更新 **含新建文件**。  
- **`plan.md`** P2 指向 **`task_P2.md`**。

---

## 6. 与 CHANGELOG 的对应

实现 P2 时，每合并一批改动，应在：

- **`sitegeist/CHANGELOG.md`** — 记 **扩展与 `scripts/`** 的新增与修改；  
- **`sitegeist-remote-bridge/CHANGELOG.md`** — 记 **本目录文档**（及日后 Pi 扩展源码）的变更。

便于和「只能动两个模块」的约束对齐审计。

---

## 7. 实现与文档差异（已落地，需知晓）

以下与 §2 表格字面略有不同，**实现优先理由**已写；若需改回字面流程可再开一轮讨论。

1. **鉴权首帧增加 `role`**：`{ "type":"auth","token":"...", "role":"extension" }`（CLI 可显式 `"role":"cli"`，**省略则视为 `cli`**）。否则桥无法区分 **扩展连接** 与 **CLI 连接**，无法做 `append_user_and_run` 转发。  
   - **sitegeist**：`remote-bridge-client.ts` 在 `onopen` 发送 **`role: "extension"`**。  
   - **桥**：`sitegeist-bridge.mjs` 登记 `extensionWs`，新 extension 连接会 **关闭** 旧 extension 连接。

2. **`registerRemoteBridgeSidepanel` 调用位置**：未放在 `initApp()` 最后一行，而是在 **`sidepanel.ts` 模块级**、在 `let agent` / `let chatPanel` / `let currentSessionId` / `let currentWindowId` **声明之后**立即注册，通过 **getter** 读取最新状态。  
   - **理由**：`initApp()` 存在 **`testSteps()` 等提前 `return`**，若只在 `initApp` 末尾注册会 **漏注册**；模块级注册保证 **abort-repl 与 remote 共用** 多 listener 模型下侧栏始终能收消息（未就绪时 handler 返回 **`not_ready`**）。

3. **`append_user_and_run` 仅允许 `role: cli` 的连接发起**（桥侧拒绝 extension 套壳发起），避免角色混乱。

4. **自动化测试**：`scripts/test-remote-bridge-p2.mjs` 中 **Node 第二个 WebSocket** 在收到转发后 **人工回 `ack`**，用于 **无 Chrome** 时验证桥中继；**真机验收**仍以侧栏 + Service worker 为准。

---

## 8. 需你在浏览器中验收的任务（**暂不执行**，有空再勾）

> 以下 **AI/CI 无法代测**，只能在你本机 Chrome 完成。当前阶段 **不要求立刻测**，仅作清单备忘。

### 8.1 扩展 ↔ 桥（P0/P1 延伸）

- [ ] **M1** 终端启动桥：`SITEGEIST_BRIDGE_TOKEN=<口令> npm run bridge`（端口与 storage 一致）。  
- [ ] **M2** `chrome://extensions` → Sitegeist → **Service worker → Inspect**，执行 `chrome.storage.local.set({ sitegeistRemoteBridge: { enabled: true, token: "<同口令>", port: 18766 } })`（端口按实际改）。  
- [ ] **M3** **Reload** 扩展后，控制台可见 **`[RemoteBridge] bridge ws open`**、**`auth_ok`** 后 **`ping ack`**。  
- [ ] **M4（可选）** 将 storage 里 `token` 改成错误值 → Reload，应出现 **连接失败 / ws closed** 等可观测失败（**S3** 类）。

### 8.2 端到端 `append_user_and_run`（P2，真侧栏）

- [ ] **M5** 侧栏打开，从地址栏抄下当前 **`session=`** 的 **UUID**（记为 `SID`）。  
- [ ] **M6** 保证 **只此窗口** 持有该会话（勿多窗口抢锁）。  
- [ ] **M7** 另开终端 `npx wscat -c ws://127.0.0.1:18766`，先发：  
  `{"type":"auth","token":"<口令>","role":"cli"}`  
  再发：  
  `{"v":1,"cmd":"append_user_and_run","id":"manual-1","sessionId":"SID","payload":{"text":"从 CLI 插入的一句"}}`  
- [ ] **M8** wscat 收到 **`type":"ack"`** 且侧栏 **出现该 user 消息并开始模型回复**；若收到 **`type":"error"`**，对照错误码（`session_not_loaded` / `lock_not_held` / `busy` / `no_sidepanel` / `not_ready`）排查。

### 8.3 与自动化分工

| 已由脚本/CI 覆盖 | 仅 §8 人工 |
|------------------|-----------|
| `npm run build`、`npm run test:bridge-p1`、`npm run test:bridge-p2`、无 token 桥退出 | **M1–M8** |
