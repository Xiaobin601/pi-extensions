# sitegeist-remote-bridge (Pi extension)

Project-local Pi extension under **`badlogic/.pi/extensions/sitegeist-remote-bridge/`**. Auto-discovered when you run **`pi` with cwd = this repo (`badlogic`) root** — see **`pi-mono/packages/coding-agent/docs/extensions.md`** (`.pi/extensions/*/index.ts`).

## Setup

1. From **`sitegeist/`**: start the bridge with the same token the browser extension uses, e.g.  
   `SITEGEIST_BRIDGE_TOKEN=your-secret npm run bridge`
2. Export the same variables in the shell where you run **`pi`** (from **`badlogic/`** root):
   - **`SITEGEIST_BRIDGE_TOKEN`** (required)
   - **`SITEGEIST_BRIDGE_PORT`** (optional, default `18766`)
   - **`SITEGEIST_BRIDGE_HOST`** (optional, default `127.0.0.1`)
3. Install extension dependencies once:  
   `cd .pi/extensions && npm install`  
   (installs **`ws`**, **`typebox`**; **`@mariozechner/pi-coding-agent`** is a **file:** dev link for types — at runtime **`pi`** resolves its own bundled packages.)

## Tools

| Tool | Purpose |
|------|---------|
| **`sitegeist_append_user`** | `sessionId` + `text` → WebSocket **`append_user_and_run`** (short cli connection). |
| **`sitegeist_bridge_ping`** | **`ping`** over the bridge to verify connectivity. |

## Spec / tasks

Implementation aligns with **`sitegeist/.pi/extensions/sitegeist-remote-bridge/task_P3.md`** (design + acceptance). Automated WS smoke (no Pi): **`cd sitegeist && npm run test:bridge-p3`**.
