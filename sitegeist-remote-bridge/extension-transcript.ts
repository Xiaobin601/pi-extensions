import type { AppendBridgeResult, StreamAppendOutcome } from "./bridge-client";

export const SITEGEIST_USER_CUSTOM_TYPE = "sitegeist_user_reflect";
export const SITEGEIST_BRIDGE_RESULT_CUSTOM_TYPE = "sitegeist_bridge_result";
export const SITEGEIST_ASSISTANT_CUSTOM_TYPE = "sitegeist_assistant_reflect";

export const TRANSCRIPT_SEPARATOR = "\n────────\n\n";
export const SITEGEIST_ECHO_MAX_CHARS = 12_000;
const SITEGEIST_BRIDGE_ASSISTANT_MAX_CHARS = 32_000;

/** Minimal Pi surface used by bridging hooks (easily mocked in tests). */
export interface PiAgentEndMessaging {
	on(event: "agent_end", handler: () => void): void;
	sendMessage(
		message: {
			customType: string;
			display: boolean;
			content: string;
			details?: unknown;
		},
		options?: { triggerTurn?: boolean },
	): void;
}

/** Queued until `agent_end`; flushed after idle so sendMessage(skip turn) avoids steer/followUp while streaming. */
export class BridgedAssistantTranscriptCoordinator {
	private pending: string[] = [];
	private hookRegistered = false;

	enqueue(raw: string): void {
		const t = typeof raw === "string" ? raw.trim() : "";
		const body =
			t.length > SITEGEIST_BRIDGE_ASSISTANT_MAX_CHARS
				? `${t.slice(0, SITEGEIST_BRIDGE_ASSISTANT_MAX_CHARS)}… [truncated]`
				: t;
		this.pending.push(body || "");
	}

	/** Once per coordinator; avoids duplicate listeners on hot reload if the same coordinator instance is reused. */
	register(pi: PiAgentEndMessaging): void {
		if (this.hookRegistered) return;
		this.hookRegistered = true;

		pi.on("agent_end", () => {
			if (this.pending.length === 0) return;
			const batch = this.pending.splice(0);

			const flush = () => {
				for (const body of batch) {
					const text = `Sitegeist assistant (bridged):\n\n${body.trim() ? body.trim() : "(empty — only non-text deltas streamed from Sitegeist)"}`;
					pi.sendMessage(
						{ customType: SITEGEIST_ASSISTANT_CUSTOM_TYPE, display: true, content: text },
						{ triggerTurn: false },
					);
				}
			};

			if (typeof setImmediate === "function") {
				setImmediate(flush);
			} else {
				setTimeout(flush, 0);
			}
		});
	}

	/** Clears queued bodies and allows `register` again (tests only). */
	resetForTests(): void {
		this.pending = [];
		this.hookRegistered = false;
	}
}

/** Production singleton wired from `index.ts`. */
export const bridgedAssistantTranscript = new BridgedAssistantTranscriptCoordinator();

/** Prefix shown in Pi TUI inside tool outcomes (extension tools run while streaming). */
export function withSentEchoBlock(sentText: string | undefined, rest: string): string {
	const t = typeof sentText === "string" ? sentText.trim() : "";
	if (!t) return rest;
	const body =
		t.length > SITEGEIST_ECHO_MAX_CHARS ? `${t.slice(0, SITEGEIST_ECHO_MAX_CHARS)}… [truncated]` : t;
	return `Sent to Sitegeist:\n\n${body}${TRANSCRIPT_SEPARATOR}${rest}`;
}

export function extractSlashBridgeOutcomeBody(firstTextBlock: string): string | undefined {
	const parts = firstTextBlock.split(TRANSCRIPT_SEPARATOR);
	const body =
		parts.length >= 2 ? parts.slice(1).join(TRANSCRIPT_SEPARATOR).trim() : firstTextBlock.trim();
	return body ? body : undefined;
}

export function formatAppendResult(sentText: string, r: AppendBridgeResult): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	if (r.kind === "ack") {
		return {
			content: [
				{
					type: "text",
					text: withSentEchoBlock(sentText, "Sitegeist bridge: message queued (append_user_and_run ack)."),
				},
			],
			details: { bridge: "ok", id: r.id, raw: r.raw },
		};
	}
	const detail = r.detail ? ` (${r.detail})` : "";
	return {
		content: [
			{
				type: "text",
				text: withSentEchoBlock(sentText, `Sitegeist bridge error: ${r.error}${detail}`),
			},
		],
		details: { bridge: "error", id: r.id, error: r.error, detail: r.detail, raw: r.raw },
	};
}

export function formatStreamAppendResult(sentText: string, r: StreamAppendOutcome): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	if (r.kind === "ok") {
		const preview =
			r.accumulated.length > 2000 ? `${r.accumulated.slice(0, 2000)}…` : r.accumulated;
		return {
			content: [
				{
					type: "text",
					text: withSentEchoBlock(
						sentText,
						`Sitegeist stream finished. Assistant text (preview):\n${preview || "(empty)"}`,
					),
				},
			],
			details: { bridge: "stream_ok", id: r.id, frameCount: r.frames.length },
		};
	}
	const detail = r.detail ? ` (${r.detail})` : "";
	return {
		content: [
			{ type: "text", text: withSentEchoBlock(sentText, `Sitegeist bridge stream error: ${r.error}${detail}`) },
		],
		details: { bridge: "stream_error", id: r.id, error: r.error, detail: r.detail, raw: r.raw },
	};
}

/** Parse `/sitegeist [--no-stream] [sessionUuid] rest…` (streaming on by default; same as sitegeist_append_user). */
export function parseSitegeistSlashArgs(raw: string): { stream: boolean; sessionId?: string; text: string } {
	let s = raw.trim();
	let stream = true;
	if (s.startsWith("--no-stream ")) {
		stream = false;
		s = s.slice("--no-stream".length).trim();
	} else if (s === "--no-stream") {
		stream = false;
		s = "";
	} else if (s.startsWith("--stream ")) {
		s = s.slice("--stream".length).trim();
	} else if (s === "--stream") {
		s = "";
	} else if (s.startsWith("-s ")) {
		s = s.slice(3).trim();
	} else if (s === "-s") {
		s = "";
	}
	if (!s) return { stream, text: "" };
	const uuidLead =
		/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+([\s\S]+)$/i.exec(s);
	if (uuidLead) {
		return { stream, sessionId: uuidLead[1], text: uuidLead[2].trim() };
	}
	return { stream, text: s };
}
