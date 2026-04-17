import { type Awaitable, type Context, type Logger, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { aiCommands } from "./commands";
import type { BilibiliNotifyAIConfig } from "./config";
import { buildSystemPrompt } from "./persona-presets";

declare module "koishi" {
	interface Context {
		"bilibili-notify-ai": BilibiliNotifyAI;
	}
}

const SERVICE_NAME = "bilibili-notify-ai";

type ConversationRole = "user" | "assistant";
interface ConversationMessage {
	role: ConversationRole;
	content: string;
}

export type AIScene = "dynamic" | "liveSummary";

export class BilibiliNotifyAI extends Service<BilibiliNotifyAIConfig> {
	static readonly [Service.provide] = SERVICE_NAME;

	private readonly aiLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private readonly sessions = new Map<string, ConversationMessage[]>();

	constructor(ctx: Context, config: BilibiliNotifyAIConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		this.aiLogger.level = config.logLevel;
		// 在服务构造时注册指令，确保在插件加载时就可用
		aiCommands.call(this);
	}

	protected start(): Awaitable<void> {
		const { preset } = this.config.persona;
		this.aiLogger.info(
			`AI 插件已启动，人格预设：${preset}，模型：${this.config.model}，多轮对话：${this.config.enableConversation ? "开启" : "关闭"}`,
		);
		this.aiLogger.debug(`[start] 系统提示词（无场景）：\n${this.getSystemPrompt()}`);
	}

	protected stop(): Awaitable<void> {
		this.sessions.clear();
		this.aiLogger.info("AI 插件已停止，会话历史已清除");
	}

	/**
	 * 获取指定场景的 system prompt。
	 * 始终以人格配置为基础，场景补充说明叠加在其后。
	 */
	getSystemPrompt(scene?: AIScene): string {
		const personaPrompt = buildSystemPrompt(this.config.persona);
		const sceneAddition =
			scene === "dynamic"
				? this.config.dynamicPrompt
				: scene === "liveSummary"
					? this.config.liveSummaryPrompt
					: "";

		return sceneAddition ? `${personaPrompt}\n${sceneAddition}` : personaPrompt;
	}

	/**
	 * 单次 AI 调用，不保存历史。
	 * 供 dynamic/live 插件调用。
	 */
	async comment(content: string, scene?: AIScene): Promise<string> {
		const systemPrompt = this.getSystemPrompt(scene);
		this.aiLogger.debug(`[comment] scene=${scene ?? "default"}, 内容长度=${content.length}`);
		const result = await this.callAPI(systemPrompt, [{ role: "user", content }]);
		this.aiLogger.debug(`[comment] 响应长度=${result.length}`);
		return result;
	}

	/**
	 * 多轮对话，按 sessionId 保存历史。
	 * 供 bili chat 指令使用。
	 */
	async chat(content: string, sessionId: string): Promise<string> {
		const history = this.sessions.get(sessionId) ?? [];
		history.push({ role: "user", content });

		const systemPrompt = this.getSystemPrompt();
		this.aiLogger.debug(
			`[chat] sessionId=${sessionId}, 历史轮次=${Math.floor(history.length / 2)}, 新消息长度=${content.length}`,
		);

		const maxMessages = this.config.maxHistory * 2;
		const trimmedHistory = history.slice(-maxMessages);

		const result = await this.callAPI(systemPrompt, trimmedHistory);
		history.push({ role: "assistant", content: result });

		this.sessions.set(sessionId, history.slice(-maxMessages));
		this.aiLogger.debug(`[chat] 响应长度=${result.length}`);
		return result;
	}

	/** 清除指定用户的对话历史 */
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.aiLogger.debug(`[clearSession] sessionId=${sessionId}`);
	}

	/** 当前活跃会话数 */
	get sessionCount(): number {
		return this.sessions.size;
	}

	private async callAPI(systemPrompt: string, messages: ConversationMessage[]): Promise<string> {
		const { apiKey, baseURL, model } = this.config;
		if (!apiKey) throw new Error("AI apiKey 未配置");
		if (!baseURL) throw new Error("AI baseURL 未配置");

		this.aiLogger.debug(`[API] baseURL=${baseURL}, model=${model}, messages=${messages.length}`);
		const { default: OpenAI } = await import("openai");
		const client = new OpenAI({ apiKey, baseURL });

		const res = await client.chat.completions.create({
			model,
			messages: [{ role: "system", content: systemPrompt }, ...messages],
		});

		return res.choices[0].message.content ?? "";
	}
}
