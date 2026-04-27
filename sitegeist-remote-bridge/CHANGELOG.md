# Changelog — sitegeist-remote-bridge

本目录为 **Pi coding-agent 扩展（规划/文档）** 与 **remote bridge 设计文档**；与 **`sitegeist`** 主仓库的 CHANGELOG 分工记录。

## [Unreleased]

### Added

- **`task_P3.md`** — Pi 扩展 **`registerTool`**、WS 短连接（`role: cli`）、配置与验收；**`plan.md`** P3 行与 §3.6/3.7 小节链接更新。
- **`sitegeist`** — **`scripts/test-remote-bridge-p3.mjs`**、**`npm run test:bridge-p3`**（见 **`task_P3.md` §7 P3-S1**）。
- **实现位置** — Pi 扩展源码在 **`badlogic/.pi/extensions/sitegeist-remote-bridge/`**（`index.ts`、`bridge-client.ts`、`config.ts`、`README.md`）；依赖在 **`badlogic/.pi/extensions/package.json`**（**`ws`**、**`typebox`**、**`pi-coding-agent`** file dev）。**`plan.md` / `task_P3.md`** 已改为以 **`badlogic` 根 cwd** 为准描述加载方式。

### Changed

- **`task_P2.md`** — 补充 **§7 实现与文档差异**（`auth.role`、侧栏注册时机）；与 `sitegeist` 落地代码对齐。

### Added (earlier)

- **`task_P0.md`** — P0 桥 + storage 联调说明。
- **`task_P1.md`** — P1 v1 协议、`ping`/`ack`、`echo`。
- **`plan.md`** — 总览与文件树。
