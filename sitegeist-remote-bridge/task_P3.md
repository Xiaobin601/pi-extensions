# P3：开发计划与验收标准

在 **P2（桥双角色 + 侧栏执行 `append_user_and_run`）** 之上，在 **pi-coding-agent 扩展** 中通过 **`registerTool`** 暴露能力，使 **`pi` CLI 里的模型** 能调用工具 → **本机 WebSocket 桥（`role: cli`）** → **已连接的 Sitegeist 扩展** → 侧栏会话。  

**实现代码位置（与本目录文档分离）**：**`badlogic/.pi/extensions/sitegeist-remote-bridge/`**（`index.ts`、`bridge-client.ts`、`config.ts`），随 **`badlogic` 根 cwd** 的 **`.pi/extensions/*/index.ts`** 规则被 `pi` 自动加载。本目录（`sitegeist/.pi/extensions/sitegeist-remote-bridge/`）保留 **plan / task_P0–P3 / CHANGELOG**。

**约束**：只动 **`sitegeist-remote-bridge`**（实现见上路径）与 **`sitegeist`**；**尽量不修改** `sitegeist` 内已在 P0–P2 落地的桥协议与扩展逻辑。

---

## 1. 需求分析（P3 解决什么问题）

| 角色 | 现状（P2 止） | P3 目标 |
|------|----------------|---------|
| **人** | 用 wscat 手写 JSON 当 CLI | 在 **`pi` 会话**里用自然语言，由 **模型选工具** 下发同一条 v1 命令 |
| **配置** | token/端口分散在 shell + storage | 扩展侧用 **环境变量或 `pi` flag** 读 **`SITEGEIST_BRIDGE_*`**，与桥进程一致即可 |
| **错误** | wscat 自己看 JSON | **`execute` 返回** 结构化 `content` + `details`，把 **`error` / `detail`** 写清楚，便于模型与用户排错 |

**不在 P3**：长驻连接池、自动重连、多会话队列、UI wizard — 留给 **P4** 或后续。

---

## 2. 范围边界

| 纳入 P3 | 不纳入 P3 |
|---------|-----------|
| **`default export (pi: ExtensionAPI)`** 注册 **至少 1 个** `registerTool`（建议名 **`sitegeist_append_user`** 或 `sitegeist_send_message`） | 改 **`sitegeist/scripts/sitegeist-bridge.mjs`** 协议（除非发现阻塞 bug） |
| 工具参数：**`sessionId`（string）**、**`text`（string）**；内部组 **`append_user_and_run`** v1 帧 + **`id`**（UUID） | 在 **`sitegeist/src/`** 再塞一套 CLI（P2 已满足） |
| **短连接**：每次 `execute` **新建 WS**：`auth(role:cli)` → 发命令 → 收 **单帧 ack/error** → `close`（实现简单，易测） | 与扩展进程 **长连接复用**（P4） |
| 把 **`no_extension_client` / `session_not_loaded` / …`** 映射为工具返回的 **可读英文/中文说明** | OAuth、多租户桥 |

---

## 3. 与上游 Pi 的契约（实现前必读）

- 扩展入口：`export default async function (pi: ExtensionAPI) { ... }` 或同步工厂 — 见 **`pi-mono/packages/coding-agent/docs/extensions.md`**。  
- **`pi.registerTool`**：`parameters` 推荐 **TypeBox** `Type.Object({...})`，`execute` 返回 **`{ content: [...], details?: ... }`**。  
- **类型与依赖**：扩展由 **`pi` 内 jiti** 加载；**`@mariozechner/pi-coding-agent`**、**`typebox`** 由运行时 **virtualModules / 别名** 注入（见 **`pi-mono/.../extensions/loader.ts`**）。**`badlogic/.pi/extensions/package.json`** 中的 **`file:`** 链接与 **`typebox` / `ws`** 依赖用于 **IDE 与 `ws` 运行时解析**；**勿**把生产 token 写进仓库。

---

## 4. 计划新建 / 修改文件（按模块）

### 4.1 **sitegeist-remote-bridge**（Pi 扩展，主战场）

源码目录：**`badlogic/.pi/extensions/sitegeist-remote-bridge/`**；依赖在 **`badlogic/.pi/extensions/package.json`**（与 `custom-provider-deepseek` 等共用 **`npm install`**）。

| 动作 | 路径（相对 `badlogic` 根） | 说明 |
|------|------|------|
| **已有** | `.pi/extensions/sitegeist-remote-bridge/index.ts` | `export default function (pi)`：**`registerTool`**（`sitegeist_append_user`、`sitegeist_bridge_ping`）。 |
| **已有** | `.pi/extensions/sitegeist-remote-bridge/bridge-client.ts` | **WS 短连接**：`auth` + **`role: cli`** → 单帧应答 → `close`；**`append_user_and_run`** / **`ping`**。 |
| **已有** | `.pi/extensions/sitegeist-remote-bridge/config.ts` | **`SITEGEIST_BRIDGE_*`** 环境变量。 |
| **已有** | `.pi/extensions/sitegeist-remote-bridge/README.md` | 发现路径、环境变量、与 **`sitegeist`** 桥的联调步骤。 |
| **改** | `.pi/extensions/package.json` | **`ws`** + **`typebox`**；**`@mariozechner/pi-coding-agent`** **file:**（类型）。 |
| **改** | **`CHANGELOG.md`**（本目录 `sitegeist/.pi/...`）、**`plan.md`** | 实现位置说明。 |

### 4.2 **sitegeist**（可选、尽量少动）

| 动作 | 路径 | 说明 |
|------|------|------|
| **新建** | `scripts/test-remote-bridge-p3.mjs` | 冒烟：**Node 模拟 Pi 工具** — 每次 **`cliAppendOnce`** 为独立短连接；`id` 用 **`crypto.randomUUID()`**；阶段 A 无扩展 → **`no_extension_client`**；阶段 B mock 扩展 → **`ack`。** |
| **改** | `package.json` | 脚本 **`test:bridge-p3`**。 |
| **默认不改** | — | P2 桥与扩展已支持 **CLI 角色**；Pi 工具即第三路 **cli** WS。 |
| **可选** | `sitegeist/README.md` 或 `docs/` | 「与 `pi` 联调」指向 **`sitegeist-remote-bridge/README.md`**。 |

---

## 5. 工具设计（建议稿）

### 5.1 `sitegeist_append_user`（名称可微调）

- **description**：向 **已打开且已连桥的 Sitegeist** 指定会话 **追加一条用户消息并触发模型**；需 **`sessionId`** 与侧栏 URL 一致，且本机桥与扩展已启用。  
- **parameters**：  
  - `sessionId`: `Type.String({ description: "UUID from sidepanel URL ?session=" })`  
  - `text`: `Type.String()`  
- **execute**：  
  1. `config` 校验 token；  
  2. `bridge-ws-client`：`auth` + `append_user_and_run`；  
  3. 若 ack：`content: [{ type:"text", text: "OK: message queued." }], details: { raw }`  
  4. 若 error：`content: [{ type:"text", text: "Sitegeist bridge error: ..." }], details: { error, detail, id }`  
- **超时**：WS 等待 ack 超过 **N ms** → 返回 **`bridge_timeout`**。

### 5.2 可选第二个工具 `sitegeist_bridge_ping`

- 仅发 **`ping`**，用于用户说「测一下桥通不通」，与 P1 对齐。

---

## 6. 开发任务（建议顺序）

1. **`badlogic/.pi/extensions/package.json`**：已加入 **`ws`**、**`typebox`**；**`@mariozechner/pi-coding-agent`** 为 **file:** dev 链接；在 **`badlogic/.pi/extensions`** 执行 **`npm install`**。  
2. **`badlogic/.pi/extensions/sitegeist-remote-bridge/config.ts`** + **`bridge-client.ts`**：WS 短连接、**`append_user_and_run`** / **`ping`**。  
3. **`badlogic/.pi/extensions/sitegeist-remote-bridge/index.ts`**：**`defineTool`** + **`registerTool`**（**`sitegeist_append_user`**、**`sitegeist_bridge_ping`**）。  
4. **`badlogic/.pi/extensions/sitegeist-remote-bridge/README.md`**：**`badlogic` 根 cwd**、环境变量、与 **`sitegeist`** 桥的联调。  
5. **`plan.md` / task_P3 / CHANGELOG`**：实现路径与验收对齐。  
6. **`npm run test:bridge-p3`**（**`sitegeist`** 根）：桥已起；不依赖 `pi`，仅复现 **工具侧 WS 行为**。

---

## 7. 验收标准

- [ ] **P3-T1** 在 **`badlogic` 仓库根**（含 `.pi/extensions/sitegeist-remote-bridge/`）执行 `pi`（或 `npx pi`），扩展被加载；工具列表含 **`sitegeist_append_user`** / **`sitegeist_bridge_ping`**（启动日志或 `/extensions` 类命令可观测，以你环境为准）。**先**在 **`badlogic/.pi/extensions`** 执行 **`npm install`** 以安装 **`ws`**、**`typebox`**（及 **`pi-coding-agent`** 的 **file:** 类型链接）。  
- [ ] **P3-T2** 桥 + Sitegeist 扩展侧栏按 **P2 §8** 就绪后，在 **`pi` 会话**里让模型调用 **`sitegeist_append_user`**，侧栏 **出现对应 user 消息并跑模型**。  
- [ ] **P3-T3** 故意关桥 / 错 `sessionId` / 关侧栏：工具返回 **明确错误文本**（非空 `content`），**不崩溃** `pi`。  
- [ ] **P3-S1** **`npm run test:bridge-p3`**（在 **`sitegeist`** 仓库根）：桥已运行时通过；用 Node **模拟 Pi 工具** — 短连接 **`auth(role:cli)`** → **`append_user_and_run`**（**`id`** 为 **`randomUUID()`**）→ 收 **`error` / `ack`** → 关闭；阶段 A 校验 **`no_extension_client`**，阶段 B 与 P2 相同 **mock extension 回 `ack`**。  
- [ ] **P3-E1** 本目录 **`npm pack` 或 `tsc --noEmit`**（若配置了）无类型错误。

---

## 8. 需人工验收（与 P2 §8 的关系）

- **P2 §8**：验证 **浏览器 + 桥** 通路。  
- **P3 §7**：在 P2 通过后，额外验证 **`pi` CLI + 工具** 整条链。  
- 可合并一次做：先 **M1–M8（task_P2 §8）**，再 **P3-T1–T3**。

---

## 9. 风险与依赖

- **`pi` 的 cwd**：扩展发现路径依赖 **当前工作目录**；本扩展请在 **`badlogic` 仓库根** 打开 `pi`，或于 **`settings.json`** 配置 **`extensions`** 绝对路径。  
- **Token**：与 **`SITEGEIST_BRIDGE_TOKEN`**、扩展 **`chrome.storage`** 三者须一致；**不要**写进 git。  
- **`ws`**：安装在 **`badlogic/.pi/extensions/node_modules`**（与目录内其他扩展共用 **`package.json`**）。

---

## 10. DoD

- §4 所列 **新建文件** 已落地，`index.ts` 可被 `pi` 加载。  
- §7 **P3-T1–T3、P3-S1、P3-E1** 满足（人工项可标「稍后」但清单保留）。  
- **`plan.md`** P3 行指向 **`task_P3.md`**；**双 CHANGELOG** 记录 P3 新增。
