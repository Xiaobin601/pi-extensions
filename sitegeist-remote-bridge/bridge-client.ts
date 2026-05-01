import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { SitegeistBridgeConfig } from "./config";
import { bridgeWsUrl } from "./config";

const PROTOCOL_V1 = 1;
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
			ws.send(JSON.stringify({ v: PROTOCOL_V1, cmd: "ping", id }));
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
	const id = randomUUID();
	const raw = await bridgeCliRoundTrip(
		config,
		(ws) => {
			const sid = input.sessionId?.trim();
			const envelope: Record<string, unknown> = {
				v: PROTOCOL_V1,
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
			v: PROTOCOL_V1,
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
