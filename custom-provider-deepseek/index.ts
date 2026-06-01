/**
 * DeepSeek Provider - 通过 OpenAI 兼容协议接入 DeepSeek
 *
 * 功能：注册 V3/V4 模型
 *   - deepseek-v4-flash: V4 Flash（1M上下文，同时支持思考/非思考模式）
 *   - deepseek-v4-pro:   V4 Pro（1M上下文，75%折扣到 2026/05/31）
 *   - deepseek-chat:     旧 V3 模型（2026/07/24 废弃，映射到 v4-flash 非思考模式）
 *   - deepseek-reasoner: 旧 R1 模型（2026/07/24 废弃，映射到 v4-flash 思考模式）
 * 认证：通过环境变量 DEEPSEEK_API_KEY 传递 API Key
 *
 * Usage:
 *   设置环境变量: export DEEPSEEK_API_KEY=sk-xxx
 *   放在 .pi/extensions/ 目录下即可自动加载
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";


export default function (pi: ExtensionAPI) {
	pi.registerProvider("deepseek", {
		// DeepSeek 官方 API 地址（兼容 OpenAI 协议）
		baseUrl: "https://api.deepseek.com/v1",
		// 对应 .env 中的环境变量名
		apiKey: "DEEPSEEK_API_KEY",
		// 使用内置 OpenAI 兼容协议，无需手写流式解析
		api: "openai-completions",

		models: [
			// ── V4 模型 ──────────────────────────────────────────────
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: false,                 // 通过 API 参数 thinking 切换
				input: ["text"],
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
				contextWindow: 1_000_000,         // 1M 上下文
				maxTokens: 384_000,               // 最大 384K 输出
			},
			{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				reasoning: false,                 // 通过 API 参数 thinking 切换
				input: ["text"],
				cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },  // 75% off 促销价
				contextWindow: 1_000_000,         // 1M 上下文
				maxTokens: 384_000,               // 最大 384K 输出
			},

			// ── 旧 V3 模型（2026/07/24 废弃，仅作兼容） ──────────────
			{
				id: "deepseek-chat",
				name: "DeepSeek V3 (deprecating)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
				contextWindow: 65536,
				maxTokens: 8192,
			},
			{
				id: "deepseek-reasoner",
				name: "DeepSeek R1 (deprecating)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
				contextWindow: 65536,
				maxTokens: 8192,
			},
		],
	});
}
