/**
 * Pi extension: call Sitegeist remote bridge (WebSocket, role cli) from the agent.
 * Design docs: sitegeist/.pi/extensions/sitegeist-remote-bridge/task_P3.md · task_P4_streaming.md
 */
import {
	defineTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	bridgeAppendUserAndRun,
	bridgeAppendUserStream,
	bridgePing,
	type StreamAppendOutcome,
} from "./bridge-client";
import { loadSitegeistBridgeConfig } from "./config";

function formatAppendResult(r: Awaited<ReturnType<typeof bridgeAppendUserAndRun>>): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	if (r.kind === "ack") {
		return {
			content: [{ type: "text", text: "Sitegeist bridge: message queued (append_user_and_run ack)." }],
			details: { bridge: "ok", id: r.id, raw: r.raw },
		};
	}
	const detail = r.detail ? ` (${r.detail})` : "";
	return {
		content: [
			{
				type: "text",
				text: `Sitegeist bridge error: ${r.error}${detail}`,
			},
		],
		details: { bridge: "error", id: r.id, error: r.error, detail: r.detail, raw: r.raw },
	};
}

function formatStreamAppendResult(r: StreamAppendOutcome): {
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
					text: `Sitegeist stream finished. Assistant text (preview):\n${preview || "(empty)"}`,
				},
			],
			details: { bridge: "stream_ok", id: r.id, frameCount: r.frames.length },
		};
	}
	const detail = r.detail ? ` (${r.detail})` : "";
	return {
		content: [{ type: "text", text: `Sitegeist bridge stream error: ${r.error}${detail}` }],
		details: { bridge: "stream_error", id: r.id, error: r.error, detail: r.detail, raw: r.raw },
	};
}

type SitegeistAppendUserResult = AgentToolResult<Record<string, unknown>>;

/** Parse `/sitegeist [--no-stream] [sessionUuid] rest…` (streaming on by default; same as sitegeist_append_user). */
function parseSitegeistSlashArgs(raw: string): { stream: boolean; sessionId?: string; text: string } {
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

async function executeSitegeistAppendUser(
	params: { sessionId?: string; text: string; stream?: boolean },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
): Promise<SitegeistAppendUserResult> {
	const loaded = loadSitegeistBridgeConfig();
	if (!loaded.ok) {
		return {
			content: [{ type: "text", text: loaded.error }],
			details: { bridge: "config", error: loaded.error },
		};
	}
	try {
		const useStream = params.stream !== false;
		if (useStream) {
			const r = await bridgeAppendUserStream(
				loaded.config,
				{ sessionId: params.sessionId, text: params.text },
				signal,
				onUpdate,
			);
			return formatStreamAppendResult(r);
		}
		const r = await bridgeAppendUserAndRun(loaded.config, params, signal);
		return formatAppendResult(r);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text", text: `Sitegeist bridge failed: ${msg}` }],
			details: { bridge: "exception", message: msg },
		};
	}
}

function notifySitegeistAppendOutcome(ctx: ExtensionCommandContext, result: SitegeistAppendUserResult): void {
	const c0 = result.content[0];
	const text =
		c0?.type === "text" ? c0.text : c0 === undefined ? "(no message)" : "(non-text content)";
	const bridge = result.details.bridge;
	const isErr =
		bridge === "error" ||
		bridge === "stream_error" ||
		bridge === "config" ||
		bridge === "exception";
	ctx.ui.notify(text, isErr ? "error" : "info");
}

const appendUserParameters = Type.Object({
	sessionId: Type.Optional(
		Type.String({
			description:
				"Session UUID from the Sitegeist sidepanel URL (?session=). Omit to use the session currently loaded in the sidepanel.",
		}),
	),
	text: Type.String({ description: "User message text to append and run" }),
	stream: Type.Optional(
		Type.Boolean({
			description:
				"Defaults to true: stream assistant deltas into the tool UI until the turn ends (longer-lived WS; set SITEGEIST_BRIDGE_STREAM_TIMEOUT_MS if needed). Set false for a short ack-only round trip.",
		}),
	),
});

const appendTool = defineTool<typeof appendUserParameters, Record<string, unknown>>({
	name: "sitegeist_append_user",
	label: "Sitegeist append user",
	description:
		"Append a user message to a Sitegeist sidepanel session and run the model. Requires the Sitegeist extension connected to the local bridge. The sidepanel shows the turn as a /sitegeist-prefixed user message so it is obvious it came from Pi. Omit sessionId to target whichever session is currently open in the sidepanel (single-window setup). If sessionId is set, it must match the sidepanel URL ?session=. Set SITEGEIST_BRIDGE_TOKEN (and optionally SITEGEIST_BRIDGE_PORT, SITEGEIST_BRIDGE_HOST). By default streams assistant text into this tool result as it is generated (set stream=false for ack-only; needs Sitegeist build with P4 streaming).",
	promptSnippet: "Send text into a Sitegeist browser session via the local WS bridge",
	promptGuidelines: [
		"Use sitegeist_append_user when the user wants to inject a message into an open Sitegeist sidepanel session (sessionId from ?session= in the URL, or omit sessionId for the current session).",
	],
	parameters: appendUserParameters,
	async execute(_toolCallId, params, signal, onUpdate) {
		return executeSitegeistAppendUser(params, signal, onUpdate);
	},
});

const pingParameters = Type.Object({});

const pingTool = defineTool<typeof pingParameters, Record<string, unknown>>({
	name: "sitegeist_bridge_ping",
	label: "Sitegeist bridge ping",
	description:
		"Ping the local Sitegeist WebSocket bridge (SITEGEIST_BRIDGE_TOKEN / SITEGEIST_BRIDGE_PORT). Use to verify the bridge process is reachable before append_user.",
	parameters: pingParameters,
	async execute(_toolCallId, _params, signal) {
		const loaded = loadSitegeistBridgeConfig();
		if (!loaded.ok) {
			return {
				content: [{ type: "text", text: loaded.error }],
				details: { bridge: "config", error: loaded.error },
			};
		}
		try {
			const raw = await bridgePing(loaded.config, signal);
			return {
				content: [{ type: "text", text: `Sitegeist bridge ping OK: ${JSON.stringify(raw)}` }],
				details: { bridge: "ping", raw },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text", text: `Sitegeist bridge ping failed: ${msg}` }],
				details: { bridge: "ping_error", message: msg },
			};
		}
	},
});

export default function sitegeistRemoteBridgeExtension(pi: ExtensionAPI) {
	pi.registerCommand("sitegeist", {
		description:
			"Send text to Sitegeist via WS bridge (usage: /sitegeist [--no-stream] [session-uuid] <message>; streaming is default)",
		handler: async (args, ctx) => {
			const parsed = parseSitegeistSlashArgs(args);
			if (!parsed.text.trim()) {
				ctx.ui.notify(
					"Usage: /sitegeist [--no-stream] [session-uuid] <message> — streams by default; optional UUID from Sitegeist ?session=; omit to use the open sidepanel session.",
					"warning",
				);
				return;
			}
			const result = await executeSitegeistAppendUser(
				{ sessionId: parsed.sessionId, text: parsed.text, stream: parsed.stream },
				ctx.signal,
				undefined,
			);
			notifySitegeistAppendOutcome(ctx, result);
		},
	});
	pi.registerTool(appendTool);
	pi.registerTool(pingTool);
}
