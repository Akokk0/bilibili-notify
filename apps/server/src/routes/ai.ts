import { CommentaryGenerator, type ConversationMessage } from "@bilibili-notify/ai";
import type {
	AiChatMessageDTO,
	AiChatReplyResponse,
	AiConversationDTO,
	AiConversationListResponse,
	AiConversationMetaResponse,
	AiConversationResponse,
	AiTestPushResponse,
	AiToolTraceDTO,
} from "@bilibili-notify/contract";
import { AISettingsSchema, type NotificationPayload } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Conversation, ConversationMeta } from "../ai/conversation-store.js";
import { REDACTED_API_KEY } from "./globals.js";
import type { RouteDeps } from "./types.js";

/**
 * 智能女仆的「试一句」。
 *
 * 拿 AI 页**当前草稿**的人格(可能还没保存)当 system prompt,用户递一句话 / 一个问题,
 * 让她回一句 → 真实推到指定的 PushTarget → 顺带把回复文本带回页面,调人格时不必跑去
 * QQ 里翻。与 `/api/cards/test-push`(草稿样式 + 真实推送)同形。
 */
const TestPushRequestSchema = z.object({
	targetId: z.uuid(),
	message: z.string().min(1).max(500),
	/** AI 页的草稿配置 —— 未保存的人格改动就靠它进来。 */
	ai: AISettingsSchema,
});

// AiTestPushResponse 在 @bilibili-notify/contract(web 同源消费)。

export function createAiRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.post("/test-push", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = TestPushRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json<AiTestPushResponse>({ ok: false, latencyMs: 0, err: "invalid_request" }, 400);
		}
		const { targetId, message, ai } = parsed.data;

		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json<AiTestPushResponse>(
				{ ok: false, latencyMs: 0, err: "engines not yet attached" },
				503,
			);
		}
		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target) {
			return c.json<AiTestPushResponse>({ ok: false, latencyMs: 0, err: "target not found" }, 404);
		}

		// 用草稿配置**临时**造一个 generator,用完即弃 —— 绝不碰正在跑的 commentary 实例,
		// 否则「试一句」会把未保存的人格泄进真实推送。
		const generator = new CommentaryGenerator({
			serviceCtx: deps.runtime.serviceCtx,
			api: engines.api,
			config: toGeneratorConfig({
				...ai,
				apiKey: resolveDraftApiKey(ai.apiKey, deps.store.getGlobals().defaults.ai.apiKey),
			}),
		});

		let reply: string;
		try {
			const r = await generator.chat(message, `test-push-${targetId}`);
			reply = r.result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json<AiTestPushResponse>({ ok: false, latencyMs: 0, err: msg }, 500);
		}

		const payload: NotificationPayload = { kind: "text", text: reply };
		const result = await engines.push.sendToTarget(target.id, payload);
		return c.json<AiTestPushResponse>({ ...result, reply });
	});

	// ---- 女仆 AI 聊天 ------------------------------------------------------
	//
	// 与上面的 `/test-push` 分工:那条吃**页面草稿**、用完即弃的 generator,是在
	// 调人格;这一族用**已保存**的配置和常驻的 commentary 实例,是在用配好的女仆
	// 干活。会话落磁盘(ConversationStore),重启后接着聊。
	const store = () => deps.runtime.conversationStore;

	app.get("/conversations", async (c) => {
		return c.json<AiConversationListResponse>({ conversations: await store().list() });
	});

	app.post("/conversations", async (c) => {
		// 刻意**不**依赖 engines / AI 配置:主人在还没配好 key 的时候点「新对话」,
		// 该看到一个空会话和一句「去把 key 填上」,而不是一个建不出来的按钮。
		return c.json<AiConversationResponse>({ conversation: toDetail(await store().create()) });
	});

	app.get("/conversations/:id", async (c) => {
		const conv = await store().get(c.req.param("id"));
		if (!conv) return c.json({ err: "会话不存在或已被删除" }, 404);
		return c.json<AiConversationResponse>({ conversation: toDetail(conv) });
	});

	app.delete("/conversations/:id", async (c) => {
		const removed = await store().remove(c.req.param("id"));
		if (!removed) return c.json({ err: "会话不存在或已被删除" }, 404);
		return c.json({ ok: true });
	});

	/**
	 * 让女仆看一眼首轮问答,给这个会话起个标题。
	 *
	 * 单开一条路而不是塞进聊天流:标题是**装饰**,聊天是正事。混在一起的话,
	 * 起名慢一点就得让主人多等着流不结束,起名失败还得在流里区分「回复失败」和
	 * 「只是没起出名字」两种错。分开之后,这条怎么错都不碍着已经聊完的那一轮。
	 *
	 * 只看首轮:标题说的是这个会话**从哪儿开始**的,给全量历史既贵又跑题。
	 *
	 * 起名失败一律回 200 + 当前标题。前端拿它去更新侧栏,没起出来就是没变化 ——
	 * 不值得为一个装饰弹红字,尤其余额不足那会儿主人正为聊天本身发愁。
	 */
	app.post("/conversations/:id/title", async (c) => {
		const engines = deps.runtime.engines;
		if (!engines) return c.json({ err: "服务尚未就绪,请稍后重试" }, 503);
		const commentary = engines.commentary;
		if (!commentary) {
			return c.json({ err: "智能女仆的 baseUrl / apiKey 还没填齐,请先到「智能女仆」页补上" }, 400);
		}

		const conv = await store().get(c.req.param("id"));
		if (!conv) return c.json({ err: "会话不存在或已被删除" }, 404);

		const firstRound = conv.messages.slice(0, 2);
		// 起过就不再起 —— 侧栏那行是主人认会话的路标,不该被反复挪。判据是这个
		// 标记而**不是**「刚聊完第一轮」:拿轮次当判据的话,功能上线前就存在的
		// 会话里早已有好几条消息,永远轮不上,标题永远停在首问那句。
		//
		// 一问一答都齐了才值得起名。只有半轮(或空会话)没什么可总结的,那一次
		// 调用纯属白花。
		if (conv.autoTitled || firstRound.length < 2) {
			return c.json({ conversation: toMeta(conv) } satisfies AiConversationMetaResponse);
		}

		try {
			const title = await commentary.summarizeTitle(
				firstRound.map((m) => ({ role: m.role, content: m.content })),
			);
			const updated = await store().setTitle(conv.id, title);
			if (updated)
				return c.json({ conversation: toMeta(updated) } satisfies AiConversationMetaResponse);
		} catch (err) {
			// warn 而不是 debug:界面上这条是**静默**失败(标题原样留着),主人只会
			// 看到「标题还是我那句提问」,却不知道为什么。日志页里得留下原因,
			// 否则这就是一条无从下手的故障。
			const msg = err instanceof Error ? err.message : String(err);
			deps.runtime.serviceCtx.logger.warn(`[ai-chat] 起标题失败,保留原标题: ${msg}`);
		}
		return c.json({ conversation: toMeta(conv) } satisfies AiConversationMetaResponse);
	});

	/**
	 * 聊天。响应是 **SSE**,不是一次性 JSON。
	 *
	 * 三种事件:`delta`(正文分片,来一段发一段)、`done`(落盘后的两条消息 +
	 * 会话元信息)、`error`(一句给人看的话)。一次回答动辄十几秒,攒到最后一次性
	 * 甩出来的话,那十几秒里页面上只有三个跳动的点,读起来像卡住了。
	 *
	 * **前置条件仍然走普通 JSON + 非 200 状态码。**这类错误("还没配 key")跟
	 * 「聊到一半断了」是两回事:前者应该像任何一个失败的请求那样被 fetch 直接
	 * 拒掉,而不是先回一个 200 的流、再在流里说其实不行 —— 那样调用方得把两种
	 * 失败分两处处理。所以 SSE 只在真的要开始生成时才开。
	 */
	app.post("/conversations/:id/chat", async (c) => {
		const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json({ err: "消息不能为空" }, 400);
		const message = parsed.data.message.trim();
		if (!message) return c.json({ err: "消息不能为空" }, 400);

		const engines = deps.runtime.engines;
		if (!engines) return c.json({ err: "服务尚未就绪,请稍后重试" }, 503);
		if (!deps.store.getGlobals().defaults.ai.enabled) {
			return c.json({ err: "智能女仆尚未启用,请先到「智能女仆」页打开开关" }, 400);
		}
		// 开关开着但实例是 null,只有一个原因:baseUrl / apiKey 没填齐。这时回
		// 「尚未启用」会把人支去翻开关 —— 而开关明明是开的,于是变成一个查不出
		// 原因的死胡同。直接指向该填的那两栏。
		const commentary = engines.commentary;
		if (!commentary) {
			return c.json({ err: "智能女仆的 baseUrl / apiKey 还没填齐,请先到「智能女仆」页补上" }, 400);
		}

		const conv = await store().get(c.req.param("id"));
		if (!conv) return c.json({ err: "会话不存在或已被删除" }, 404);

		// 先在内存里拼出「历史 + 这一问」交给女仆,**拿到回复之后才落盘**。
		// 反过来先写用户消息的话,AI 那一跳一失败,磁盘上就留下一个没人回答的
		// 问题;主人重开会话看到的是自己在自言自语,还得手动删。
		const history: ConversationMessage[] = [
			...conv.messages.map((m) => ({ role: m.role, content: m.content })),
			{ role: "user" as const, content: message },
		];

		return streamSSE(c, async (sse) => {
			/**
			 * 这一轮调过的工具,按**开始**的先后排 —— 那是主人眼看着它们冒出来的
			 * 顺序,落盘之后重开会话得对得上。所以 start 时就占好位子,end 只回填
			 * 成败,而不是等 end 再往后排(那样先开后完的会被插到后面去)。
			 *
			 * 落盘时只取回填过的:一条永远停在「进行中」的痕迹,在界面上就是一个
			 * 转到天荒地老的圈,而落完盘就再没有第二次机会补状态了。
			 */
			const slots: Array<{ name: string; args: Record<string, string>; ok?: boolean }> = [];
			const byId = new Map<string, (typeof slots)[number]>();

			let reply: string;
			try {
				const r = await commentary.chatStatelessStream(history, {
					onDelta: (text) => {
						// 不 await:回调是同步的,这里排一次写就行。真要背压也轮不到
						// 这一层管 —— SSE 的写在内存里排队,量级是几十 KB。
						void sse.writeSSE({ event: "delta", data: JSON.stringify({ text }) });
					},
					onToolEvent: (ev) => {
						// 先转发再记账:实时那一份才是这个事件存在的理由,落盘是顺带。
						void sse.writeSSE({ event: "tool", data: JSON.stringify(ev) });
						if (ev.phase === "start") {
							const slot = { name: ev.name, args: ev.args };
							slots.push(slot);
							byId.set(ev.id, slot);
							return;
						}
						const slot = byId.get(ev.id);
						if (slot) slot.ok = ev.ok;
					},
				});
				reply = r.result;
			} catch (err) {
				await sse.writeSSE({
					event: "error",
					data: JSON.stringify({ err: err instanceof Error ? err.message : String(err) }),
				});
				return;
			}

			const traces = slots.filter((s): s is AiToolTraceDTO => s.ok !== undefined);
			const updated = await store().appendMessages(conv.id, [
				{ role: "user", content: message },
				{ role: "assistant", content: reply, tools: traces },
			]);
			if (!updated) {
				// 聊天期间这个会话被删了(另一个标签页 / 超出会话数上限被修剪)。
				await sse.writeSSE({
					event: "error",
					data: JSON.stringify({ err: "会话不存在或已被删除" }),
				});
				return;
			}

			const [user, assistant] = updated.messages.slice(-2) as [AiChatMessageDTO, AiChatMessageDTO];
			const payload: AiChatReplyResponse = {
				user,
				reply: assistant,
				conversation: toMeta(updated),
			};
			await sse.writeSSE({ event: "done", data: JSON.stringify(payload) });
		});
	});

	return app;
}

/**
 * 上限比 `/test-push` 的 500 宽得多:那条是「试一句人格」,这条是真聊天,主人
 * 可能整段贴一份文案进来让女仆改。
 */
const ChatRequestSchema = z.object({
	message: z.string().min(1).max(4000),
});

/**
 * 会话 → 侧栏要的那点元信息(不驮消息体)。
 *
 * `messageCount` 是**算**出来的而不是存出来的:落盘结构里没有这个字段,存了就
 * 得跟 messages 同步维护,裁剪一次忘了改就永久对不上。
 */
function toMeta(conv: Conversation): ConversationMeta {
	return {
		id: conv.id,
		title: conv.title,
		createdAt: conv.createdAt,
		updatedAt: conv.updatedAt,
		messageCount: conv.messages.length,
		autoTitled: conv.autoTitled,
	};
}

/** 会话 → 详情载荷(元信息 + 全部消息)。 */
function toDetail(conv: Conversation): AiConversationDTO {
	return { ...toMeta(conv), messages: conv.messages };
}

/**
 * 草稿里的 apiKey → 真正拿去调 OpenAI 的那把 key。
 *
 * 前端 GET /api/globals 拿到的 apiKey 是 REDACTED 占位(真 key 从不出后端)。用户只要
 * 没动过那一栏,草稿回传的就是占位串本身 —— 原样拿去当 key 必然 401。占位 = 「没改」,
 * 回落到已存的真 key;否则用草稿里的新值(这样还没保存就能先试一把)。
 *
 * 与 `globals.ts` 的 `stripRedactedSecrets` 同一约定,共用同一个哨兵常量 —— 这个
 * magic string 只能有一个定义处。
 */
export function resolveDraftApiKey(draft: string | undefined, stored: string | undefined): string {
	if (draft === REDACTED_API_KEY) return stored ?? "";
	return draft ?? "";
}

/**
 * 草稿 AI 配置 → CommentaryGeneratorConfig。
 *
 * 字段名映射与 `engines.ts` 的 buildAiConfig 一致:schema 用面向用户的 `baseRole` /
 * `extraSystemPrompt`,引擎的 PersonaConfig 用历史命名 `customBase` / `extraPrompt`。
 * preset 固定 `custom` —— 页面上的人格字段就是最终人格,不再二次套内置模板。
 */
export function toGeneratorConfig(ai: z.infer<typeof AISettingsSchema>) {
	return {
		apiKey: ai.apiKey ?? "",
		baseURL: ai.baseUrl ?? "",
		model: ai.model,
		temperature: ai.temperature,
		persona: {
			preset: "custom" as const,
			name: ai.persona.name,
			addressUser: ai.persona.addressUser,
			addressSelf: ai.persona.addressSelf,
			traits: ai.persona.traits,
			catchphrase: ai.persona.catchphrase,
			customBase: ai.persona.baseRole,
			extraPrompt: ai.persona.extraSystemPrompt,
		},
		dynamicPrompt: ai.dynamicPrompt,
		liveSummaryPrompt: ai.liveSummaryPrompt,
		enableConversation: false,
		maxHistory: 6,
		enableThinking: false,
		enableSearch: false,
		enableVision: false,
	};
}
