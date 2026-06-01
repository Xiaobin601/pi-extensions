#!/usr/bin/env node
/**
 * Test whether DeepSeek Chat API models accept image input and can describe them.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY=sk-xxx
 *   node pi-extensions/scripts/test-deepseek-vision.mjs
 *
 * Optional:
 *   DEEPSEEK_BASE_URL=https://api.deepseek.com/v1  (default)
 *   DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro  (comma-separated)
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODELS = (process.env.DEEPSEEK_MODELS ?? "deepseek-v4-flash,deepseek-v4-pro,deepseek-chat")
	.split(",")
	.map((m) => m.trim())
	.filter(Boolean);

const IMAGE_PATH = join(__dirname, "../../pi-mono/packages/ai/test/data/red-circle.png");

const PROMPT =
	"What do you see in this image? Reply in English with only the shape and color (e.g. red circle).";

function loadApiKey() {
	if (API_KEY) return API_KEY;
	const envPath = join(__dirname, "../../.env");
	if (!existsSync(envPath)) return undefined;
	const line = readFileSync(envPath, "utf8")
		.split("\n")
		.find((l) => l.startsWith("DEEPSEEK_API_KEY"));
	if (!line) return undefined;
	const m = line.match(/DEEPSEEK_API_KEY\s*=\s*"?([^"\n]+)"?/);
	return m?.[1];
}

function loadImageBase64() {
	if (!existsSync(IMAGE_PATH)) {
		throw new Error(`Test image not found: ${IMAGE_PATH}`);
	}
	return readFileSync(IMAGE_PATH).toString("base64");
}

async function testModel(model, imageBase64) {
	const url = `${BASE_URL}/chat/completions`;
	const body = {
		model,
		stream: false,
		max_tokens: 256,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: PROMPT },
					{
						type: "image_url",
						image_url: { url: `data:image/png;base64,${imageBase64}` },
					},
				],
			},
		],
	};

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	const raw = await res.text();
	let json;
	try {
		json = JSON.parse(raw);
	} catch {
		json = { raw };
	}

	if (!res.ok) {
		return {
			model,
			ok: false,
			status: res.status,
			error: json?.error?.message ?? json?.error ?? raw.slice(0, 500),
		};
	}

	const text = json?.choices?.[0]?.message?.content ?? "";
	const lower = text.toLowerCase();
	const sawRed = lower.includes("red");
	const sawCircle = lower.includes("circle");

	return {
		model,
		ok: true,
		status: res.status,
		reply: text.trim(),
		visionLikely: sawRed && sawCircle,
		hints: { sawRed, sawCircle },
	};
}

let apiKey;

async function main() {
	apiKey = loadApiKey();
	if (!apiKey) {
		console.error("Missing DEEPSEEK_API_KEY. Set env or add to repo .env");
		process.exit(1);
	}

	const imageBase64 = loadImageBase64();
	console.log(`Base URL: ${BASE_URL}`);
	console.log(`Image: ${IMAGE_PATH}`);
	console.log(`Models: ${MODELS.join(", ")}\n`);

	const results = [];
	for (const model of MODELS) {
		process.stdout.write(`Testing ${model} ... `);
		try {
			const r = await testModel(model, imageBase64);
			results.push(r);
			if (!r.ok) {
				console.log(`FAIL (HTTP ${r.status})`);
				console.log(`  Error: ${typeof r.error === "string" ? r.error : JSON.stringify(r.error)}`);
			} else if (r.visionLikely) {
				console.log("OK — likely saw the image (red + circle)");
				console.log(`  Reply: ${r.reply}`);
			} else {
				console.log("OK — request accepted, but reply may not reflect vision");
				console.log(`  Reply: ${r.reply}`);
				console.log(`  Hints: red=${r.hints.sawRed}, circle=${r.hints.sawCircle}`);
			}
		} catch (err) {
			console.log("ERROR");
			console.log(`  ${err.message}`);
			results.push({ model, ok: false, error: err.message });
		}
		console.log();
	}

	const accepted = results.filter((r) => r.ok);
	const vision = results.filter((r) => r.visionLikely);
	console.log("--- Summary ---");
	console.log(`Accepted image in request: ${accepted.length}/${MODELS.length}`);
	console.log(`Described red circle correctly: ${vision.length}/${MODELS.length}`);

	if (accepted.length === 0) {
		console.log("\nConclusion: DeepSeek Chat API does NOT accept image input (or key/base URL issue).");
		process.exit(2);
	}
	if (vision.length === 0) {
		console.log("\nConclusion: API may accept images but models did not demonstrate vision on this test.");
		process.exit(1);
	}
	console.log("\nConclusion: At least one model appears to support image recognition.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
