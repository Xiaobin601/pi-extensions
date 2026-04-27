/**
 * Pi extension: call Sitegeist remote bridge (WebSocket, role cli) from the agent.
 * Design docs: sitegeist/.pi/extensions/sitegeist-remote-bridge/task_P3.md
 */
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeAppendUserAndRun, bridgePing } from "./bridge-client";
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

const appendTool = defineTool({
	name: "sitegeist_append_user",
	label: "Sitegeist append user",
	description:
		"Append a user message to a Sitegeist sidepanel session and run the model. Requires the Sitegeist extension connected to the local bridge, matching sessionId in the sidepanel URL. Set SITEGEIST_BRIDGE_TOKEN (and optionally SITEGEIST_BRIDGE_PORT, SITEGEIST_BRIDGE_HOST).",
	promptSnippet: "Send text into a Sitegeist browser session via the local WS bridge",
	promptGuidelines: [
		"Use sitegeist_append_user when the user wants to inject a message into an open Sitegeist sidepanel session (sessionId from ?session= in the URL).",
	],
	parameters: Type.Object({
		sessionId: Type.String({
			description: "Session UUID from the Sitegeist sidepanel URL query ?session=",
		}),
		text: Type.String({ description: "User message text to append and run" }),
	}),
	async execute(_toolCallId, params, signal) {
		const loaded = loadSitegeistBridgeConfig();
		if (!loaded.ok) {
			return {
				content: [{ type: "text", text: loaded.error }],
				details: { bridge: "config", error: loaded.error },
			};
		}
		try {
			const r = await bridgeAppendUserAndRun(loaded.config, params, signal);
			return formatAppendResult(r);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text", text: `Sitegeist bridge failed: ${msg}` }],
				details: { bridge: "exception", message: msg },
			};
		}
	},
});

const pingTool = defineTool({
	name: "sitegeist_bridge_ping",
	label: "Sitegeist bridge ping",
	description:
		"Ping the local Sitegeist WebSocket bridge (SITEGEIST_BRIDGE_TOKEN / SITEGEIST_BRIDGE_PORT). Use to verify the bridge process is reachable before append_user.",
	parameters: Type.Object({}),
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
	pi.registerTool(appendTool);
	pi.registerTool(pingTool);
}
