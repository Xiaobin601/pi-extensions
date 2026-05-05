import { describe, expect, it, vi } from "vitest";
import type { PiAgentEndMessaging } from "./extension-transcript";
import {
	BridgedAssistantTranscriptCoordinator,
	SITEGEIST_ASSISTANT_CUSTOM_TYPE,
	extractSlashBridgeOutcomeBody,
	formatAppendResult,
	formatStreamAppendResult,
	parseSitegeistSlashArgs,
	TRANSCRIPT_SEPARATOR,
	withSentEchoBlock,
} from "./extension-transcript";

describe("parseSitegeistSlashArgs", () => {
	it("parses message only", () => {
		expect(parseSitegeistSlashArgs("hello")).toEqual({ stream: true, text: "hello" });
	});

	it("honors --no-stream", () => {
		expect(parseSitegeistSlashArgs("--no-stream ping")).toEqual({ stream: false, text: "ping" });
	});

	it("parses UUID then message", () => {
		const id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
		expect(parseSitegeistSlashArgs(`${id} do thing`)).toEqual({
			stream: true,
			sessionId: id,
			text: "do thing",
		});
	});
});

describe("withSentEchoBlock", () => {
	it("returns rest only when empty", () => {
		expect(withSentEchoBlock("  ", "tail")).toBe("tail");
	});

	it("prepends echoed block + separator + rest", () => {
		const s = withSentEchoBlock("hi", "rest");
		expect(s).toContain("Sent to Sitegeist:");
		expect(s).toContain(TRANSCRIPT_SEPARATOR);
		expect(s.endsWith("rest")).toBe(true);
	});
});

describe("formatAppendResult / formatStreamAppendResult", () => {
	it("formats ack", () => {
		const r = formatAppendResult("x", {
			kind: "ack",
			id: "i1",
			raw: {},
		});
		expect(r.details.bridge).toBe("ok");
		expect(r.content[0]?.text).toContain("queued");
	});

	it("formats stream_ok with preview truncation", () => {
		const long = "z".repeat(2500);
		const r = formatStreamAppendResult("x", {
			kind: "ok",
			id: "i2",
			accumulated: long,
			frames: [],
		});
		expect(r.details.bridge).toBe("stream_ok");
		expect(r.content[0]?.text).toContain("…");
	});
});

describe("extractSlashBridgeOutcomeBody", () => {
	it("takes segment after echoed prefix separator", () => {
		const full = withSentEchoBlock("sent", "outcome tail");
		expect(extractSlashBridgeOutcomeBody(full)).toBe("outcome tail");
	});
});

describe("BridgedAssistantTranscriptCoordinator", () => {
	it("buffers until agent_end and flushes async", async () => {
		const coordinator = new BridgedAssistantTranscriptCoordinator();
		let agentEndHandler: () => void = () => {};
		const sendMessage = vi.fn();

		const pi: PiAgentEndMessaging = {
			on(_event: "agent_end", handler: () => void) {
				agentEndHandler = handler;
			},
			sendMessage(...args: Parameters<PiAgentEndMessaging["sendMessage"]>) {
				sendMessage(...args);
			},
		};

		coordinator.register(pi);
		coordinator.enqueue("alpha");
		agentEndHandler();

		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(sendMessage).toHaveBeenCalledTimes(1);
		const [[msg]] = sendMessage.mock.calls;
		expect((msg as { customType?: string }).customType).toBe(SITEGEIST_ASSISTANT_CUSTOM_TYPE);
		expect(String((msg as { content?: string }).content)).toMatch(/^Sitegeist assistant \(bridged\):/);
		expect(String((msg as { content?: string }).content)).toContain("alpha");
	});
});
