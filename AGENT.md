# Pi Extension 开发规范

> 本规范适用于为 [pi-coding-agent](https://github.com/nickselvaggio/pi-mono) 编写自定义扩展插件。
> Agent 在编写插件代码时必须严格遵循以下约定。

## 一、核心原则

1. **简洁优先**：代码尽量精简，只写必要逻辑，避免冗余抽象。
2. **注释清晰**：每个导出函数、关键逻辑块都必须有中文注释说明其用途。
3. **类型安全**：利用 `@mariozechner/pi-coding-agent` 和 `@mariozechner/pi-ai` 提供的类型定义。

## 二、文件结构

### 单文件扩展（推荐用于简单插件）

```
my-extension.ts          # 单个 .ts 文件即可
```

### 目录扩展（用于需要依赖或多文件的复杂插件）

```
my-extension/
├── index.ts             # 入口文件（必须）
├── package.json         # 仅在需要第三方依赖时添加
└── AGENT.md             # 可选：插件说明文档
```

## 三、入口格式

每个扩展**必须** `export default` 一个接受 `ExtensionAPI` 参数的函数：

```typescript
/**
 * 插件名称 - 一句话描述功能
 *
 * Usage:
 *   pi --extension ./path/to/extension.ts
 *   # 或复制到 ~/.pi/agent/extensions/ 自动加载
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 在此注册工具、命令、事件监听、Provider 等
}
```

## 四、常用 API 速查

### 4.1 注册自定义 Provider（OpenAI 兼容）

DeepSeek 等兼容 OpenAI 协议的 API，使用 `api: "openai-completions"` 即可，无需自行实现流式解析：

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-provider", {
    // API 基础地址
    baseUrl: "https://api.example.com/v1",
    // 环境变量名（pi 自动从 process.env 读取此变量的值作为 API Key）
    apiKey: "MY_PROVIDER_API_KEY",
    // 使用内置的 OpenAI 兼容协议，无需手写流式解析
    api: "openai-completions",

    // 模型列表
    models: [
      {
        id: "model-id",                    // API 实际使用的模型 ID
        name: "Model Display Name",        // 在 /model 列表中显示的名称
        reasoning: true,                   // 是否支持思考/推理
        input: ["text"],                   // 输入类型：["text"] 或 ["text", "image"]
        cost: { input: 2, output: 8, cacheRead: 0.1, cacheWrite: 1 }, // 每百万 token 的美元价格
        contextWindow: 65536,              // 上下文窗口大小（token 数）
        maxTokens: 8192,                   // 最大输出 token 数
      },
    ],
  });
}
```

### 4.2 注册自定义工具（Tool）

```typescript
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const myTool = defineTool({
  name: "tool_name",
  label: "Tool Label",
  description: "工具的功能描述，Agent 根据此描述决定何时调用",
  parameters: Type.Object({
    param1: Type.String({ description: "参数说明" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `结果: ${params.param1}` }],
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(myTool);
}
```

> **注意**：字符串枚举参数必须使用 `StringEnum` 而非 `Type.Union`（Google API 兼容性要求）：
> ```typescript
> import { StringEnum } from "@mariozechner/pi-ai";
> action: StringEnum(["list", "add"] as const)
> ```

### 4.3 注册命令（/command）

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("mycommand", {
    description: "命令描述（显示在帮助列表中）",
    handler: async (args, ctx) => {
      // args: 命令后面的参数文本
      // ctx: ExtensionContext，包含 ui、sessionManager 等
      ctx.ui.notify(`你输入了: ${args}`, "info");
    },
  });
}
```

### 4.4 监听生命周期事件

```typescript
export default function (pi: ExtensionAPI) {
  // 会话启动时触发
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("扩展已加载", "info");
  });

  // 每轮对话结束时触发
  pi.on("turn_end", async (_event, ctx) => {
    console.log("Agent 本轮回复结束");
  });

  // 工具调用前触发（可拦截）
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("危险操作", "确认执行 rm -rf？");
      if (!ok) return { block: true, reason: "用户取消" };
    }
  });

  // 退出时触发
  pi.on("session_shutdown", async (_event, ctx) => {
    console.log("即将退出");
  });
}
```

### 4.5 执行外部命令

```typescript
// 使用 pi.exec 执行外部命令（推荐，不会污染上下文）
const { stdout, stderr, code } = await pi.exec("git", ["status", "--porcelain"]);
if (code === 0) {
  console.log("干净的工作目录");
}
```

## 五、注释规范

```typescript
/**
 * DeepSeek Custom Provider - 通过 OpenAI 兼容接口接入 DeepSeek 模型
 *
 * 功能：注册 deepseek-chat 和 deepseek-reasoner 两个模型
 * 认证：通过环境变量 DEEPSEEK_API_KEY 传递 API Key
 *
 * Usage:
 *   复制到 ~/.pi/agent/extensions/ 或项目的 .pi/extensions/ 目录
 *   设置环境变量: export DEEPSEEK_API_KEY=sk-xxx
 */
```

- 文件头部：用 JSDoc 注释说明插件名称、功能、使用方法
- 关键配置项：用行内注释说明每个字段含义
- 复杂逻辑：在代码块上方用 `//` 注释解释为什么这样做

## 六、完整示例：DeepSeek Provider 插件

以下是一个**最简洁的**自定义 Provider 扩展示例，将其作为参考模板：

```typescript
/**
 * DeepSeek Provider - 通过 OpenAI 兼容协议接入 DeepSeek
 *
 * Usage:
 *   设置环境变量: export DEEPSEEK_API_KEY=sk-xxx
 *   复制到 ~/.pi/agent/extensions/ 或 .pi/extensions/ 即可自动加载
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("deepseek", {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "DEEPSEEK_API_KEY",
    api: "openai-completions",

    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek V3",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
        contextWindow: 65536,
        maxTokens: 8192,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek R1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
        contextWindow: 65536,
        maxTokens: 8192,
      },
    ],
  });
}
```

## 七、放置位置

| 位置 | 路径 | 作用域 |
|:---|:---|:---|
| 全局 | `~/.pi/agent/extensions/` | 所有项目共享 |
| 项目级 | `<项目根目录>/.pi/extensions/` | 仅当前项目 |
| 命令行 | `pi --extension ./path.ts` | 仅本次会话 |

## 八、调试与验证

1. 启动 `pi` 后输入 `/config` 查看 `[Extensions]` 区域确认扩展已加载
2. 修改代码后输入 `/reload` 热重载（无需重启）
3. 如果加载失败，TUI 会显示红色错误信息
