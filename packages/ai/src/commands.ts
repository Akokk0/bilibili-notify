import type {} from "@koishijs/plugin-help";
import type { BilibiliNotifyAI } from "./ai-service";

export function aiCommands(this: BilibiliNotifyAI): void {
	// bili ai — 单次测试指令
	this.ctx
		.command("bili.ai [prompt:text]", "向 AI 发送一条测试消息", { hidden: true })
		.usage("验证 AI 配置是否正确")
		.example("bili ai 你好")
		.action(async (_, prompt = "你好，请简单介绍一下你自己") => {
			const ai = this.ctx.get("bilibili-notify-ai") as BilibiliNotifyAI | null;
			if (!ai) return "AI 插件尚未就绪";
			try {
				const result = await ai.comment(prompt);
				return result;
			} catch (e) {
				return `AI 调用失败：${(e as Error).message}`;
			}
		});

	// bili chat — 多轮对话指令
	this.ctx
		.command("bili.chat [message:text]", "与 AI 进行多轮对话")
		.usage("开始与 AI 对话，AI 会记住本次会话的上下文")
		.example("bili chat 最近有什么有趣的动态吗")
		.option("clear", "-c 清除当前对话历史")
		.action(async ({ session, options }, message) => {
			const ai = this.ctx.get("bilibili-notify-ai") as BilibiliNotifyAI | null;
			if (!ai) return "AI 插件尚未就绪";

			const sessionId = `${session?.platform}:${session?.userId}`;

			if (options?.clear) {
				ai.clearSession(sessionId);
				return "对话历史已清除";
			}

			if (!message?.trim()) return "请输入消息内容";

			if (!ai.config.enableConversation) {
				try {
					const result = await ai.comment(message);
					return result;
				} catch (e) {
					return `AI 调用失败：${(e as Error).message}`;
				}
			}

			try {
				const result = await ai.chat(message, sessionId);
				return result;
			} catch (e) {
				return `AI 调用失败：${(e as Error).message}`;
			}
		});
}
