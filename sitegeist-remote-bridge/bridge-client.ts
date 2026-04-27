import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { SitegeistBridgeConfig } from "./config";
import { bridgeWsUrl } from "./config";

const PROTOCOL_V1 = 1;
const DEFAULT_WAIT_MS = 30_000;

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
	input: { sessionId: string; text: string },
	signal: AbortSignal | undefined,
	waitMs = DEFAULT_WAIT_MS,
): Promise<AppendBridgeResult> {
	const id = randomUUID();
	const raw = await bridgeCliRoundTrip(
		config,
		(ws) => {
			ws.send(
				JSON.stringify({
					v: PROTOCOL_V1,
					cmd: "append_user_and_run",
					id,
					sessionId: input.sessionId,
					payload: { text: input.text },
				}),
			);
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
