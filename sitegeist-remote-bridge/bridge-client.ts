import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { REMOTE_BRIDGE_PROTOCOL_V1 } from "@badlogic/sitegeist-bridge-protocol";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { SitegeistBridgeConfig } from "./config";
import { bridgeWsUrl } from "./config";

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_STREAM_WAIT_MS = 900_000;

function onceJson(ws: WebSocket, ms: number, signal: AbortSignal | undefined): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			cleanup();
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			reject(new Error("bridge_timeout"));
		}, ms);
		const onAbort = () => {
			cleanup();
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			reject(new Error("aborted"));
		};
		const cleanup = () => {
			clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		ws.once("message", (data) => {
			cleanup();
			try {
				resolve(JSON.parse(data.toString()));
			} catch (e) {
				reject(e);
			}
		});
		ws.once("error", (e) => {
			cleanup();
			reject(e);
		});
	});
}

function connectWs(url: string, signal: AbortSignal | undefined): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const onAbort = () => {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		ws.on("error", (e) => {
			signal?.removeEventListener("abort", onAbort);
			reject(e);
		});
		ws.on("open", () => {
			signal?.removeEventListener("abort", onAbort);
			resolve(ws);
		});
	});
}

/** Short-lived cli socket: auth → one v1 command → first JSON response → close. */
export async function bridgeCliRoundTrip(
	config: SitegeistBridgeConfig,
	sendAfterAuth: (ws: WebSocket) => void,
	signal: AbortSignal | undefined,
	waitMs = DEFAULT_WAIT_MS,
): Promise<unknown> {
	const url = bridgeWsUrl(config);
	const ws = await connectWs(url, signal);
	try {
		ws.send(JSON.stringify({ type: "auth", token: config.token, role: "cli" }));
		const auth = await onceJson(ws, waitMs, signal);
		if (
			typeof auth !== "object" ||
			auth === null ||
			(auth as { type?: string }).type !== "auth_ok"
		) {
			throw new Error(`bridge auth failed: ${JSON.stringify(auth)}`);
		}
		sendAfterAuth(ws);
		return await onceJson(ws, waitMs, signal);
	} finally {
		try {
			ws.close();
		} catch {
			/* ignore */
		}
	}
}

export async function bridgePing(
	config: SitegeistBridgeConfig,
	signal: AbortSignal | undefined,
	waitMs = DEFAULT_WAIT_MS,
): Promise<unknown> {
	const id = randomUUID();
	return bridgeCliRoundTrip(
		config,
		(ws) => {
			ws.send(JSON.stringify({ v: REMOTE_BRIDGE_PROTOCOL_V1, cmd: "ping", id }));
		},
		signal,
		waitMs,
	);
}

export type AppendBridgeResult =
	| { kind: "ack"; id: string; raw: unknown }
	| { kind: "error"; id: string; error: string; detail?: string; raw: unknown };

export async function bridgeAppendUserAndRun(
	config: SitegeistBridgeConfig,
	input: { sessionId?: string; text: string },
	signal: AbortSignal | undefined,
	waitMs = DEFAULT_WAIT_MS,
): Promise<AppendBridgeResult> {
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) {
			console.log(`[sitegeist-bridge] retry append_user, attempt ${attempt + 1}/5`);
			await new Promise(r => setTimeout(r, 1000));
		}
		const result = await doBridgeAppendUserAndRun(config, input, signal, waitMs);
		// Retry on transient errors
		if (result.kind === "error" && (result.error === "no_extension_client" || result.error === "no_sidepanel")) {
			if (attempt < 2) continue;
		}
		return result;
	}
	return { kind: "error", id: "", error: "retry_exhausted", raw: {} };
}

async function doBridgeAppendUserAndRun(
	config: SitegeistBridgeConfig,
	input: { sessionId?: string; text: string },
	signal: AbortSignal | undefined,
	waitMs: number,
): Promise<AppendBridgeResult> {
	const id = randomUUID();
	const raw = await bridgeCliRoundTrip(
		config,
		(ws) => {
			const sid = input.sessionId?.trim();
			const envelope: Record<string, unknown> = {
				v: REMOTE_BRIDGE_PROTOCOL_V1,
				cmd: "append_user_and_run",
				id,
				payload: { text: input.text },
			};
			if (sid) envelope.sessionId = sid;
			ws.send(JSON.stringify(envelope));
		},
		signal,
		waitMs,
	);

	if (typeof raw !== "object" || raw === null) {
		return { kind: "error", id, error: "invalid_response", raw };
	}
	const o = raw as Record<string, unknown>;
	if (o.type === "ack" && o.ok === true) {
		return { kind: "ack", id, raw };
	}
	if (o.type === "error") {
		return {
			kind: "error",
			id: typeof o.id === "string" ? o.id : id,
			error: typeof o.error === "string" ? o.error : "unknown_error",
			detail: typeof o.detail === "string" ? o.detail : undefined,
			raw,
		};
	}
	return { kind: "error", id, error: "unexpected_envelope", raw };
}

export type StreamAppendOutcome =
	| { kind: "ok"; id: string; accumulated: string; frames: unknown[] }
	| { kind: "error"; id: string; error: string; detail?: string; raw?: unknown };

/**
 * Long-lived cli socket: `append_user_and_run` with `payload.stream: true`, then
 * `ack` (queued) + zero or more `stream` + `stream_end` (or `error`).
 *
 * Buffers WS JSON frames so bursts (ack + stream + stream_end) are not lost vs `once`.
 */
function attachJsonMessageQueue(ws: WebSocket) {
	const q: unknown[] = [];
	const pending: Array<(v: unknown) => void> = [];
	const onData = (data: WebSocket.RawData) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			return;
		}
		const r = pending.shift();
		if (r) r(parsed);
		else q.push(parsed);
	};
	ws.on("message", onData);
	return {
		read(): Promise<unknown> {
			if (q.length > 0) return Promise.resolve(q.shift()!);
			return new Promise<unknown>((resolve) => {
				pending.push(resolve);
			});
		},
		detach() {
			ws.off("message", onData);
		},
	};
}

export async function bridgeAppendUserStream(
	config: SitegeistBridgeConfig,
	input: { sessionId?: string; text: string },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
	waitMs = Number(process.env.SITEGEIST_BRIDGE_STREAM_TIMEOUT_MS || DEFAULT_STREAM_WAIT_MS),
): Promise<StreamAppendOutcome> {
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) {
			console.log(`[sitegeist-bridge] retry append_user_stream, attempt ${attempt + 1}/5`);
			await new Promise(r => setTimeout(r, 1000));
		}
		const result = await doBridgeAppendUserStream(config, input, signal, onUpdate, waitMs);
		if (result.kind === "error" && (result.error === "no_extension_client" || result.error === "no_sidepanel")) {
			if (attempt < 2) continue;
		}
		return result;
	}
	return { kind: "error", id: "", error: "retry_exhausted" };
}

async function doBridgeAppendUserStream(
	config: SitegeistBridgeConfig,
	input: { sessionId?: string; text: string },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
	waitMs: number,
): Promise<StreamAppendOutcome> {
	const id = randomUUID();
	const url = bridgeWsUrl(config);
	const ws = await connectWs(url, signal);
	const perReadMs = Math.min(waitMs, 120_000);
	const frames: unknown[] = [];
	let accumulated = "";

	const queue = attachJsonMessageQueue(ws);

	const readTimed = (): Promise<unknown> =>
		new Promise((resolve, reject) => {
			let settled = false;
			const t = setTimeout(() => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error("bridge_timeout"));
			}, perReadMs);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error("aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void queue.read().then(
				(v) => {
					if (settled) return;
					settled = true;
					clearTimeout(t);
					signal?.removeEventListener("abort", onAbort);
					resolve(v);
				},
				(e) => {
					if (settled) return;
					settled = true;
					clearTimeout(t);
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
			);
		});

	try {
		ws.send(JSON.stringify({ type: "auth", token: config.token, role: "cli" }));
		const auth = await readTimed();
		if (
			typeof auth !== "object" ||
			auth === null ||
			(auth as { type?: string }).type !== "auth_ok"
		) {
			throw new Error(`bridge auth failed: ${JSON.stringify(auth)}`);
		}

		const sid = input.sessionId?.trim();
		const envelope: Record<string, unknown> = {
			v: REMOTE_BRIDGE_PROTOCOL_V1,
			cmd: "append_user_and_run",
			id,
			payload: { text: input.text, stream: true },
		};
		if (sid) envelope.sessionId = sid;
		ws.send(JSON.stringify(envelope));

		for (;;) {
			const raw = await readTimed();
			frames.push(raw);
			const o = raw as Record<string, unknown>;
			if (o.type === "error") {
				return {
					kind: "error",
					id: typeof o.id === "string" ? o.id : id,
					error: typeof o.error === "string" ? o.error : "unknown_error",
					detail: typeof o.detail === "string" ? o.detail : undefined,
					raw,
				};
			}
			if (o.type === "stream" && typeof o.delta === "string") {
				accumulated += o.delta;
				onUpdate?.({
					content: [{ type: "text", text: accumulated }],
					details: { bridge: "stream_delta" },
				});
				continue;
			}
			if (o.type === "stream_end") {
				return { kind: "ok", id, accumulated, frames };
			}
			if (o.type === "ack" && o.cmd === "append_user_and_run") {
				continue;
			}
			return {
				kind: "error",
				id,
				error: "unexpected_frame",
				raw,
			};
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg === "aborted") {
			return { kind: "error", id, error: "aborted" };
		}
		return { kind: "error", id, error: msg };
	} finally {
		queue.detach();
		try {
			ws.close();
		} catch {
			/* ignore */
		}
	}
}

// ── list_sessions (pi → sitegeist): query sidepanel sessions ──

export async function bridgeListSessions(
	config: SitegeistBridgeConfig,
	signal: AbortSignal | undefined,
): Promise<{ sessions: Array<{id: string; name: string; provider: string; model: string; messageCount: number; lastUpdated: string}> }> {
	const id = randomUUID();
	const raw = await bridgeCliRoundTrip(
		config,
		(ws) => {
			ws.send(JSON.stringify({ v: REMOTE_BRIDGE_PROTOCOL_V1, cmd: "list_sessions", id }));
		},
		signal,
		DEFAULT_WAIT_MS,
	);
	if (typeof raw !== "object" || raw === null) throw new Error("empty response");
	const o = raw as Record<string, unknown>;
	if (o.type === "error") throw new Error((o.error as string) || "list_sessions error");
	const payload = o.payload as { sessions?: unknown[] } | undefined;
	return { sessions: (payload?.sessions as any[]) || [] };
}

// ── Persistent listener for exec_bash (Sitegeist → pi direction) ──

let listenerWs: WebSocket | null = null;
let listenerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listenerRunning = false;

/** Handler for agent_delegate requests from Sitegeist */
export type DelegateHandler = (
	request: {
		id: string;
		mode: string;
		prompt: string;
		tool?: string;
		tool_params?: Record<string, unknown>;
		tools?: string[];
		cwd?: string;
		max_turns?: number;
		depth: number;
		max_depth: number;
	},
	sendResult: (result: { ok: boolean; error?: string; result?: string; turns_used?: number; tool_calls?: Array<{ tool: string; summary: string }> }) => void,
) => void;

let delegateHandler: DelegateHandler | null = null;

/** Start a persistent WS connection that listens for exec_bash and agent_delegate */
export function startBridgeExecBashListener(
	config: SitegeistBridgeConfig,
	onDelegate?: DelegateHandler,
): void {
	if (listenerRunning) return;
	listenerRunning = true;
	delegateHandler = onDelegate ?? null;
	void connectListenerLoop(config);
}

/** Stop the persistent listener. */
export function stopBridgeExecBashListener(): void {
	listenerRunning = false;
	if (listenerReconnectTimer) {
		clearTimeout(listenerReconnectTimer);
		listenerReconnectTimer = null;
	}
	if (listenerWs) {
		try { listenerWs.close(); } catch { /* ignore */ }
		listenerWs = null;
	}
}

async function connectListenerLoop(config: SitegeistBridgeConfig): Promise<void> {
	while (listenerRunning) {
		try {
			await runListenerConnection(config);
		} catch (e) {
			console.error("[sitegeist-listener] connection error:", (e as Error).message);
		}
		if (!listenerRunning) break;
		// Reconnect after 5s delay
		await new Promise<void>((resolve) => {
			listenerReconnectTimer = setTimeout(resolve, 5000);
		});
	}
}

async function runListenerConnection(config: SitegeistBridgeConfig): Promise<void> {
	const url = bridgeWsUrl(config);
	const ws = new WebSocket(url);
	listenerWs = ws;

	await new Promise<void>((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});

	// Auth
	ws.send(JSON.stringify({ type: "auth", token: config.token, role: "cli" }));
	const authResp = await new Promise<Record<string, unknown>>((resolve, reject) => {
		ws.once("message", (data) => {
			try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
		});
		ws.once("error", reject);
	});
	if (authResp.type !== "auth_ok") {
		throw new Error(`listener auth failed: ${JSON.stringify(authResp)}`);
	}

	// Register as listener
	const listenerId = randomUUID();
	ws.send(JSON.stringify({ v: REMOTE_BRIDGE_PROTOCOL_V1, cmd: "register_listener", id: listenerId }));
	const regResp = await new Promise<Record<string, unknown>>((resolve, reject) => {
		ws.once("message", (data) => {
			try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
		});
	});
	if (regResp.type !== "ack" || regResp.ok !== true) {
		throw new Error(`listener register failed: ${JSON.stringify(regResp)}`);
	}
	console.log("[sitegeist-listener] registered, waiting for exec_bash commands");

	// Listen for exec_bash commands
	ws.on("message", (data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.cmd !== "exec_bash" && msg.cmd !== "agent_delegate") return;
	if (typeof msg.id !== "string") return;

	// ── agent_delegate: generic multi-agent RPC ──
	if (msg.cmd === "agent_delegate") {
		const id = msg.id;
		const pl = msg.payload as Record<string, unknown> | undefined;
		if (!delegateHandler) {
			ws.send(JSON.stringify({
				v: REMOTE_BRIDGE_PROTOCOL_V1, type: "agent_delegate_result",
				id, cmd: "agent_delegate",
				payload: { ok: false, error: "no delegate handler registered" },
			}));
			return;
		}
		// Depth check
		const depth = (pl?.depth as number) ?? 0;
		const maxDepth = (pl?.max_depth as number) ?? 2;
		if (depth >= maxDepth) {
			ws.send(JSON.stringify({
				v: REMOTE_BRIDGE_PROTOCOL_V1, type: "agent_delegate_result",
				id, cmd: "agent_delegate",
				payload: { ok: false, error: `max_depth (${maxDepth}) exceeded at depth ${depth}` },
			}));
			return;
		}
		console.log(`[sitegeist-listener] agent_delegate id=${id} mode=${pl?.mode} depth=${depth}`);
		delegateHandler(
			{
				id,
				mode: (pl?.mode as string) || "direct",
				prompt: (pl?.prompt as string) || "",
				tool: pl?.tool as string | undefined,
				tool_params: pl?.tool_params as Record<string, unknown> | undefined,
				tools: pl?.tools as string[] | undefined,
				cwd: pl?.cwd as string | undefined,
				max_turns: pl?.max_turns as number | undefined,
				depth,
				max_depth: maxDepth,
			},
			(result) => {
				try {
					ws.send(JSON.stringify({
						v: REMOTE_BRIDGE_PROTOCOL_V1,
						type: "agent_delegate_result",
						id,
						cmd: "agent_delegate",
						payload: result,
					}));
				} catch { /* ignore */ }
			},
		);
		return;
	}

	// ── exec_bash ──
	const id = msg.id as string;
		const payload = msg.payload as { command?: string; cwd?: string; timeoutMs?: number } | undefined;
		if (!payload?.command) {
			ws.send(JSON.stringify({
				v: REMOTE_BRIDGE_PROTOCOL_V1,
				type: "exec_bash_result",
				id,
				cmd: "exec_bash",
				payload: { stdout: "", stderr: "missing command", code: 1 },
			}));
			return;
		}

		console.log(`[sitegeist-listener] exec_bash id=${id}:`, payload.command.substring(0, 120));

		// Execute and respond
		const { exec } = require("child_process");
		exec(
			payload.command,
			{
				cwd: payload.cwd || process.cwd(),
				timeout: payload.timeoutMs || 30000,
				maxBuffer: 1024 * 1024,
			},
			(error: Error | null, stdout: string, stderr: string) => {
				const result = {
					v: REMOTE_BRIDGE_PROTOCOL_V1,
					type: "exec_bash_result",
					id,
					cmd: "exec_bash",
					payload: {
						stdout: stdout || "",
						stderr: stderr || "",
						code: error?.code ?? 0,
					},
				};
				try {
					ws.send(JSON.stringify(result));
				} catch {
					console.error("[sitegeist-listener] failed to send exec_bash_result");
				}
			},
		);
	});

	ws.on("close", () => {
		listenerWs = null;
		console.log("[sitegeist-listener] connection closed");
	});

	// Wait for close
	await new Promise<void>((resolve) => {
		ws.on("close", resolve);
	});
}
