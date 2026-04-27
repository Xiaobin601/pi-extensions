/**
 * DeepSeek Provider - 通过 OpenAI 兼容协议接入 DeepSeek
 *
 * 功能：注册 deepseek-chat (V3) 和 deepseek-reasoner (R1) 两个模型
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
			{
				id: "deepseek-chat",              // API 模型 ID
				name: "DeepSeek V3",              // 在 /model 列表中的显示名称
				reasoning: false,                 // V3 不支持推理模式
				input: ["text"],                  // 仅支持文本输入
				cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
				contextWindow: 65536,             // 64K 上下文窗口
				maxTokens: 8192,                  // 最大输出 8K tokens
			},
			{
				id: "deepseek-reasoner",           // API 模型 ID
				name: "DeepSeek R1",               // 在 /model 列表中的显示名称
				reasoning: true,                   // R1 支持深度推理（思维链）
				input: ["text"],                   // 仅支持文本输入
				cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
				contextWindow: 65536,              // 64K 上下文窗口
				maxTokens: 8192,                   // 最大输出 8K tokens
			},
		],
	});
}
