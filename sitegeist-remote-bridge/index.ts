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
import { bridgeAppendUserAndRun, bridgeAppendUserStream, bridgePing, startBridgeExecBashListener, stopBridgeExecBashListener } from "./bridge-client";
import { loadSitegeistBridgeConfig } from "./config";
import {
	SITEGEIST_BRIDGE_RESULT_CUSTOM_TYPE,
	SITEGEIST_USER_CUSTOM_TYPE,
	SITEGEIST_ECHO_MAX_CHARS,
	bridgedAssistantTranscript,
	extractSlashBridgeOutcomeBody,
	formatAppendResult,
	formatStreamAppendResult,
	parseSitegeistSlashArgs,
	withSentEchoBlock,
} from "./extension-transcript";

type SitegeistAppendUserResult = AgentToolResult<Record<string, unknown>>;

/** Slash `/sitegeist` has no tool card — append bridge outcome body (after echoed prefix) to the transcript */
function appendBridgeOutcomeToSlashTranscript(pi: ExtensionAPI, result: SitegeistAppendUserResult): void {
	const c0 = result.content[0];
	if (c0?.type !== "text") return;
	const body = extractSlashBridgeOutcomeBody(c0.text);
	if (!body) return;

	pi.sendMessage(
		{
			customType: SITEGEIST_BRIDGE_RESULT_CUSTOM_TYPE,
			display: true,
			content: body,
			details: result.details,
		},
		{ triggerTurn: false },
	);
}

/** Slash command only: transcript line when idle (after waitForIdle). */
function echoSentTextIntoPiTranscript(pi: ExtensionAPI, params: { text: string; sessionId?: string }): void {
	const t = typeof params.text === "string" ? params.text.trim() : "";
	if (!t) return;
	const sid = params.sessionId?.trim();
	const header = sid ? `Sent to Sitegeist (session ${sid}):\n\n` : "Sent to Sitegeist:\n\n";
	const body =
		t.length > SITEGEIST_ECHO_MAX_CHARS ? `${t.slice(0, SITEGEIST_ECHO_MAX_CHARS)}… [truncated]` : t;

	pi.sendMessage(
		{
			customType: SITEGEIST_USER_CUSTOM_TYPE,
			display: true,
			content: header + body,
			details: sid ? { sessionId: sid } : undefined,
		},
		{ triggerTurn: false },
	);
}

async function executeSitegeistAppendUser(
	params: { sessionId?: string; text: string; stream?: boolean },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
	opts?: { skipDeferredBridgedAssistantBubble?: boolean },
): Promise<SitegeistAppendUserResult> {
	const sentText = params.text;
	const loaded = loadSitegeistBridgeConfig();
	if (!loaded.ok) {
		return {
			content: [{ type: "text", text: withSentEchoBlock(sentText, loaded.error) }],
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
			if (!opts?.skipDeferredBridgedAssistantBubble && r.kind === "ok") {
				bridgedAssistantTranscript.enqueue(r.accumulated);
			}
			return formatStreamAppendResult(sentText, r);
		}
		const r = await bridgeAppendUserAndRun(loaded.config, params, signal);
		return formatAppendResult(sentText, r);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text", text: withSentEchoBlock(sentText, `Sitegeist bridge failed: ${msg}`) }],
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

/** After `/sitegeist`, avoid duplicating echoed text + tool body in toast (conversation already lists them). */
function notifySitegeistSlashBrief(ctx: ExtensionCommandContext, result: SitegeistAppendUserResult): void {
	const bridge = result.details.bridge as string | undefined;
	const isErr =
		bridge === "error" ||
		bridge === "stream_error" ||
		bridge === "config" ||
		bridge === "exception";
	if (isErr) {
		notifySitegeistAppendOutcome(ctx, result);
		return;
	}
	if (bridge === "stream_ok") {
		ctx.ui.notify("Sitegeist stream finished — see transcript (custom bubble + bridged assistant lines).", "info");
		return;
	}
	if (bridge === "ok") {
		ctx.ui.notify("Sitegeist: message queued.", "info");
		return;
	}
	ctx.ui.notify("Sitegeist command finished.", "info");
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

const pingParameters = Type.Object({});

const pingTool = defineTool<typeof pingParameters, Record<string, unknown>>({
	name: "sitegeist_bridge_ping",
	label: "Sitegeist bridge ping",
	description:
		"Ping the local Sitegeist WebSocket bridge (SITEGEIST_BRIDGE_TOKEN / SITEGEIST_BRIDGE_PORT). Use to verify the bridge process is reachable before append_user.",
	parameters: pingParameters,
	async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
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
	bridgedAssistantTranscript.register(pi);

	// ── Start persistent listener for exec_bash (Sitegeist → pi direction) ──
	const listenerConfig = loadSitegeistBridgeConfig();
	if (listenerConfig.ok) {
		startBridgeExecBashListener(listenerConfig.config);
		console.log("[sitegeist-remote-bridge] exec_bash listener started");
	} else {
		console.log("[sitegeist-remote-bridge] exec_bash listener skipped (no bridge config)");
	}

	pi.on("unload", () => {
		stopBridgeExecBashListener();
	});

	const appendTool = defineTool<typeof appendUserParameters, Record<string, unknown>>({
		name: "sitegeist_append_user",
		label: "Sitegeist append user",
		description:
			"Append a user message to a Sitegeist sidepanel session and run the model. Requires the Sitegeist extension connected to the local bridge. The sidepanel shows the turn as a /sitegeist-prefixed user message so it is obvious it came from Pi. Omit sessionId to target whichever session is currently open in the sidepanel (single-window setup). If sessionId is set, it must match the sidepanel URL ?session=. Set SITEGEIST_BRIDGE_TOKEN (and optionally SITEGEIST_BRIDGE_PORT, SITEGEIST_BRIDGE_HOST). Streams assistant deltas into tool output while running; after the Pi turn settles, mirrored assistant text appears as a custom transcript line ('Sitegeist assistant (bridged)') for UIs that do not emphasize tool panels.",
		promptSnippet: "Send text into a Sitegeist browser session via the local WS bridge",
		promptGuidelines: [
			"Use sitegeist_append_user when the user wants to inject a message into an open Sitegeist sidepanel session (sessionId from ?session= in the URL, or omit sessionId for the current session).",
		],
		parameters: appendUserParameters,
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			return executeSitegeistAppendUser(params, signal, onUpdate);
		},
	});

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
			await ctx.waitForIdle();
			echoSentTextIntoPiTranscript(pi, {
				sessionId: parsed.sessionId,
				text: parsed.text,
			});
			const result = await executeSitegeistAppendUser(
				{ sessionId: parsed.sessionId, text: parsed.text, stream: parsed.stream },
				ctx.signal,
				undefined,
				{ skipDeferredBridgedAssistantBubble: true },
			);
			appendBridgeOutcomeToSlashTranscript(pi, result);
			notifySitegeistSlashBrief(ctx, result);
		},
	});
	pi.registerTool(appendTool);
	pi.registerTool(pingTool);
}
