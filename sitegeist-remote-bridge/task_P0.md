# P0：开发计划与验收标准

**Sitegeist Remote Bridge** 的 P0 只做：**本机桥 WebSocket 服务 + 共享密钥鉴权 + Sitegeist background 作为 WS 客户端连上并完成一次往返**。不实现 Pi `registerTool`、不实现 sidepanel 改会话、不驱动 Agent（分别留给 P3、P2）。

---

## 1. 范围边界

| 纳入 P0 | 不纳入 P0 |
|---------|-----------|
| 桥进程：`ws` 仅监听 **`127.0.0.1`**，默认端口 **`18766`**（与 `dev-server` 8765 错开，可用环境变量覆盖） | HTTPS、域名、公网暴露 |
| 首帧或连接后第一条消息完成 **token 校验**（见 §2） | 完整业务协议 `cmd` / `sessionId`（P1） |
| 校验通过后桥对客户端消息做 **echo**（原样或包一层 `{ "type":"echo", "body": ... }` 即可） | Pi 扩展、`append_user_and_run` |
| Sitegeist **background** 发起 `WebSocket`、发鉴权、收 echo、**`console.log` 可观测** | sidepanel 内 Agent 逻辑 |

---

## 2. Token 约定（P0 最小可行）

- **桥启动**：若未设置 `SITEGEIST_BRIDGE_TOKEN`，**打印错误并退出**（避免无鉴权裸跑）。  
- **客户端**：在 WebSocket 子协议不可用时，采用 **首条文本帧 JSON**：`{"type":"auth","token":"<token>"}`；桥校验失败则 **关闭连接**（可带 close reason / 先回一条错误 JSON 再关）。  
- **可选**：同时支持查询参数 `?token=`（若实现简单且仍仅绑定 loopback）；二选一写进实现说明即可。

---

## 3. 开发任务（建议顺序）

1. **`scripts/sitegeist-bridge.mjs`（或等效单文件）**  
   - 使用 Node `import { WebSocketServer } from 'ws'` 或 **`npm:ws`**（若仓库已依赖则复用；优先 **`ws` 包** 与 `package.json` devDependency 二选一记清）。  
   - 监听 `127.0.0.1:PORT`，`PORT` 默认 `18766`，支持 `SITEGEIST_BRIDGE_PORT`。  
   - 对每个连接：读第一条消息 → 校验 token → 通过后进入 echo 循环；失败则关闭并 **stderr 打一行原因**。  

2. **Sitegeist `background`（或现有 background 入口文件）**  
   - 增加「开发 / 实验」开关（例如 `chrome.storage.local` 键 `bridge.enabled`，或仅 **开发构建** 下 `import.meta` / 编译常量），避免生产用户默认连 localhost。  
   - 开关为真时：`new WebSocket('ws://127.0.0.1:18766')`，`onopen` 发送 `auth` JSON；`onmessage` 将内容 **console.log**；`onerror` / `onclose` 打日志。  
   - **不在 P0** 强制实现自动重连；若实现简单可记为「加分项」写入验收备注。  

3. **本地联调说明**（可写在 §6 或后续 `README.md`）  
   - 终端 A：`SITEGEIST_BRIDGE_TOKEN=testtoken node scripts/sitegeist-bridge.mjs`  
   - 加载扩展 → 打开 background service worker 控制台 → 打开 bridge 开关（若用 storage，可先在代码里临时默认 true 仅 P0 联调，合并前改为显式开关）。  

4. **无扩展自测（验收辅助）**  
   - 用 `npx wscat` 或 10 行 Node 脚本连 `ws://127.0.0.1:18766`，发 auth + 任意字符串，确认收到 echo。  

---

## 4. 验收标准（必须全部满足）

### 4.1 桥（Node）

- [ ] **B1** 未设置 `SITEGEIST_BRIDGE_TOKEN` 时进程 **退出码非 0**，且 stderr 有明确提示。  
- [ ] **B2** 监听地址为 **`127.0.0.1`**（不是 `0.0.0.0` / 不是省略 host 导致全网卡）。  
- [ ] **B3** 默认端口为 **18766**，且与文档/常量一致；可通过环境变量改端口且不写死魔法数散落多处。  
- [ ] **B4** 错误 token：连接可被拒绝或首帧后关闭，**不会在无鉴权状态下进入 echo**。  
- [ ] **B5** 正确 token：任意一条客户端文本消息在鉴权成功后 **能收到桥回显**（内容可约定为 echo 包或原文）。  

### 4.2 Sitegeist（Chrome 扩展）

- [ ] **S1** 在 background 控制台可见 **连接成功** 日志（例如 `bridge ws open`）。  
- [ ] **S2** 发送 auth 后收到 **至少一条** echo，`console.log` 输出与发送内容可对应（不要求 UI）。  
- [ ] **S3** 错误 token 时 background 侧可见 **失败**（关闭或错误帧），且无静默失败。  

### 4.3 整体验收

- [ ] **E1** 不启动桥时，扩展侧行为符合预期（不崩溃、不无限重试占满 CPU；可单次报错或静默，需在实现里写明一种策略）。  
- [ ] **E2** 第三方用 `wscat` + 正确 token 能独立完成 **B5**，证明桥不依赖扩展即可测。

---

## 5. P0 完成定义（DoD）

- 上述 **B1–B5、S1–S3、E1–E2** 全部勾选。  
- **`task_P0.md` §6** 或 **`README.md`** 中保留 **一条可复制** 的启动命令与环境变量说明。  
- Code review：确认 **无 token 提交进 git**。

---

## 6. 联调命令备忘（与当前实现对齐）

### 6.1 启动桥（终端 A）

勿把真实 token 写进 git；仅在本机 shell 或私密 env 中设置。

```bash
cd /path/to/sitegeist
export SITEGEIST_BRIDGE_TOKEN='your-secret-here'
export SITEGEIST_BRIDGE_PORT=18766   # 可选，默认 18766
npm run bridge
# 等价: node ./scripts/sitegeist-bridge.mjs
```

未设置 `SITEGEIST_BRIDGE_TOKEN` 时进程 **非 0 退出**，stderr 提示必填。

### 6.2 打开扩展侧连接（Chrome）

扩展使用 **`chrome.storage.local`** 单键（整对象替换）：

| 键 | 类型 | 说明 |
|----|------|------|
| `sitegeistRemoteBridge` | `object` | `{ "enabled": true, "token": "<与桥相同>", "port": 18766 }` · `port` 可选 · 扩展连桥时会自动发送 **`auth` + `role: "extension"`**（P2） |

在 **扩展程序 → Sitegeist → Service worker → Inspect → Application → Storage → Local** 中写入上述键值，或 DevTools Console：

```js
chrome.storage.local.set({
  sitegeistRemoteBridge: { enabled: true, token: "your-secret-here", port: 18766 },
});
```

然后 **Reload** 扩展（或触发 service worker 重启）。在 Service worker 控制台应看到 `[RemoteBridge] bridge ws open`、收到 `auth_ok` 后自动发送 **v1 `ping`** 以及 **`ping ack`** 日志（P1）。

关闭桥：将 `enabled` 设为 `false` 或删除该 storage 键。

### 6.3 仅验证桥（不加载扩展）

```bash
# 需已安装 wscat；先启动桥（§6.1）
npx wscat -c ws://127.0.0.1:18766
# 连接后粘贴首帧（与 token 一致）:
{"type":"auth","token":"your-secret-here"}
# P1 起：鉴权后再发 v1 信封，例如 ping（见 task_P1.md §6）
# {"v":1,"cmd":"ping","id":"wscat-1"}
```

P1 之后 **不再** 使用纯文本 echo；自测请用 **`npm run test:bridge-p1`**（需桥已启动）或 **`task_P1.md` §6**。

**在 Chrome 里做的验收**（可延后）：见 **`task_P2.md` §8**。
