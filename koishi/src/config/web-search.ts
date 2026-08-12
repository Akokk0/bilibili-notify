import type { WebSearchBackendId } from "@bilibili-notify/internal";
import type { AIConfig } from "./ai";

/**
 * koishi 的扁平搜索字段 → `webSearchExecutorFromSettings` 认识的形状。
 * 「当前后端 key 为空 = 未配置」的判据在工厂那侧,这里只折形状、不重写判断。
 *
 * 独立成文件而不是住在 `./ai` 里:那边 import 了 koishi 的 Schema(运行时依赖),
 * 纯函数跟着它就没法在无 koishi 的测试环境里加载。这里只有 `import type`,零运行时。
 */
export function webSearchSettingsOf(config: AIConfig): {
	backend: WebSearchBackendId;
	keys: Record<WebSearchBackendId, string>;
} {
	return {
		backend: config.webSearchBackend ?? "bocha",
		keys: {
			bocha: config.webSearchBochaKey ?? "",
			tavily: config.webSearchTavilyKey ?? "",
		},
	};
}
