import {
	CommentaryGenerator,
	type ConversationMessage,
	webSearchExecutorFromSettings,
} from "@bilibili-notify/ai";
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
import {
	type AISettings,
	AISettingsSchema,
	type NotificationPayload,
	providerMeta,
	resolveAIProfile,
	resolveChatThinkingLevel,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Conversation, ConversationMeta } from "../ai/conversation-store.js";
import { toGeneratorConfig } from "../runtime/ai-config.js";
import {
	deleteChatImage,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGES_PER_MESSAGE,
	readChatImage,
	readChatImageDataUrl,
	saveChatImage,
} from "../runtime/chat-assets.js";
import {
	type ChatSkinImage,
	createSkinChatTools,
	SKIN_MODE_SYSTEM_PROMPT,
} from "../skins/chat-tool.js";
import type { SkinStore } from "../skins/store.js";
import { REDACTED_API_KEY } from "./globals.js";
import type { RouteDeps } from "./types.js";
import { uploadBodyLimit } from "./upload-limit.js";

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

export function createAiRoute(
	deps: RouteDeps,
	opts?: {
		/**
		 * 皮肤库。给了才把 `create_skin` 挂进聊天 —— 女仆手上唯一一个会写东西的
		 * 工具,不该因为「某处装配忘了传」而以别的形式凭空出现。
		 */
		skinStore?: SkinStore;
	},
): Hono {
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
			// 草稿里的 apiKey 可能是脱敏占位(页面从未见过真值) —— 用已存的那把补回来。
			// 两边都要按**同一个桶**取:草稿选的是哪家,就拿那家已存的 key。
			config: toGeneratorConfig(withStoredApiKey(ai, deps.store.getGlobals().defaults.ai)),
		});

		let reply: string;
		try {
			reply = await generator.chat(message, `test-push-${targetId}`);
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
		const id = c.req.param("id");
		// 先把图片 id 抄下来再删会话 —— 删完就再也问不出这个会话带过哪些图了,
		// 那些文件会在磁盘上永远留着,而这种泄漏要很久之后才会被发现。
		const doomed = await store().get(id);
		const removed = await store().remove(id);
		if (!removed) return c.json({ err: "会话不存在或已被删除" }, 404);
		const doomedImages = (doomed?.messages ?? []).flatMap((m) => m.images ?? []);
		if (doomedImages.length > 0) {
			const dataDir = deps.store.bootstrap.dataDir;
			for (const img of doomedImages) await deleteChatImage(dataDir, img);
		}
		return c.json({ ok: true });
	});

	// ---- 聊天附件 ---------------------------------------------------------
	//
	// 与卡片背景图的图廊分开:那边是主人精心挑的长期素材,这边是随手一发、跟着
	// 会话生灭的。照抄那套「落盘 + id 引用 + 定向读取」的形状,但各用各的目录。

	/** 上传一张附件 → 落盘 `<dataDir>/assets/chat/<id>`,返回 id 供随消息带上。 */
	// 闸在 parseBody 之前:超大的当场回绝,别先整份读进那 512MB 的堆里。见 upload-limit.ts。
	app.post("/assets", uploadBodyLimit(MAX_CHAT_IMAGE_BYTES, "图片"), async (c) => {
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) return c.json({ ok: false, err: "缺少图片文件" }, 400);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const id = await saveChatImage(deps.store.bootstrap.dataDir, bytes, file.type);
			return c.json({ ok: true, id });
		} catch (err) {
			return c.json({ ok: false, err: String((err as Error)?.message ?? err) }, 400);
		}
	});

	/**
	 * 附件服务 —— 供页面显示缩略图。
	 *
	 * 经 id 正则校验的**定向读取**,绝不 serveStatic 整个 dataDir —— 那里面躺着
	 * `bn.config.yaml`,带 apiKey 与 cookie。
	 */
	app.get("/assets/:id", async (c) => {
		const res = await readChatImage(deps.store.bootstrap.dataDir, c.req.param("id"));
		if (!res) return c.json({ err: "图片不存在" }, 404);
		return c.body(res.bytes as unknown as ArrayBuffer, 200, {
			"content-type": res.mime,
			// 内容按 id 寻址,id 是随机的、永不复用 —— 可以放心长缓存。
			"cache-control": "public, max-age=31536000, immutable",
		});
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

		// 附件。看图有**两条路**:主模型自己看(enableVision),或交给副模型转文字
		// (vision.model)。两条都没开的话图是彻底没人看的 —— 静默吞掉会让主人看着
		// 女仆一本正经地聊天却对图只字不提,以为是模型笨,而真正的原因在另一个页面上。
		const attached = parsed.data.images ?? [];
		if (attached.length > 0) {
			const aiCfg = deps.store.getGlobals().defaults.ai;
			const aiProfile = resolveAIProfile(aiCfg);
			// 「主模型直接看图」这条路还要那家**真有**视觉模型才算数:DeepSeek 官方
			// 接口一个都没有,勾着开关也只会把图带到模型那儿才被拒 —— 白烧一次请求,
			// 报错还来自上游、主人看不懂。这里当场拦下并指路。
			const mainModelCanSee =
				aiProfile.enableVision && providerMeta(aiProfile.provider).supportsVision;
			if (!mainModelCanSee && !aiProfile.vision.model.trim()) {
				return c.json(
					{
						// 这句是**按控件名指路**的,两个引号里的名字必须与设置页
						// FIELD_LABELS 里的 label 一字不差 —— 指向一个叫不出名字的
						// 控件,比不给指引更让人打转。
						err: "女仆还看不见图片。请到「智能女仆」页的「图片理解」:主模型自己看得见图就打开「主模型支持看图」;看不见(比如 DeepSeek)就填上「视觉模型 ID」",
					},
					400,
				);
			}
		}
		// id → data URL。视觉服务商在公网,拉不到主人本地的
		// `http://localhost:9000/api/ai/assets/xxx` —— 只能把字节本身带过去。
		// 这与 B 站动态里的图不同,那些本来就是公网可达的,所以那条路直接传 URL。
		const resolved: Array<{ id: string; url: string }> = [];
		if (attached.length > 0) {
			const dataDir = deps.store.bootstrap.dataDir;
			for (const id of attached) {
				const url = await readChatImageDataUrl(dataDir, id);
				// 非法 id(穿越尝试)与盘上已经没了的 id 一律跳过,不让它们混进去。
				if (url) resolved.push({ id, url });
			}
		}

		// 先在内存里拼出「历史 + 这一问」交给女仆,**拿到回复之后才落盘**。
		// 反过来先写用户消息的话,AI 那一跳一失败,磁盘上就留下一个没人回答的
		// 问题;主人重开会话看到的是自己在自言自语,还得手动删。
		const history: ConversationMessage[] = [
			...conv.messages.map((m) => ({ role: m.role, content: m.content })),
			{ role: "user" as const, content: message },
		];

		/**
		 * 皮肤工坊模式的装配。写能力**只在这个模式里存在**(主人拍板的隔离):
		 * 日常聊天的上下文里有 B 站动态正文、图片里的字这些外部可控文本,写工具
		 * 挂在那儿就是给注入面开口。这个模式反过来 —— 人格、B 站只读工具都不带,
		 * 模型手上只有 create_skin 一把(联网搜索按主人那颗胶囊来,做「某部作品
		 * 风格」的皮肤离不开它)。
		 *
		 * 工具**每个请求现配**:它带着「一轮最多两套」的预算,建在装配处的话那把
		 * 计数器会跨请求累加 —— 聊到第三句就再也做不了皮肤,而且得重启才恢复。
		 */
		const skinMode = parsed.data.mode === "skin";
		if (skinMode && !opts?.skinStore) {
			// 静默退回普通聊天的话,主人会在一个根本做不了皮肤的窗口里反复说
			// 「做套皮肤」,而女仆一本正经地打太极。
			return c.json({ err: "皮肤工坊在这个部署里没有装配好,请改用聊天模式" }, 400);
		}
		const skinTools =
			skinMode && opts?.skinStore
				? createSkinChatTools({
						skinStore: opts.skinStore,
						// 热读同 ai-edit:engines 是后挂的,别做快照。
						generator: () => deps.runtime.engines?.commentary ?? null,
						/**
						 * 壁纸来源之一:主人**这一问**贴的图。字节直接从聊天附件目录读 ——
						 * 上面那份 resolved 是喂给视觉模型的 data URL,拿它再解一次 base64
						 * 只是绕远路。
						 */
						attachedImages: async () => {
							const dataDir = deps.store.bootstrap.dataDir;
							const out: ChatSkinImage[] = [];
							for (const { id } of resolved) {
								const img = await readChatImage(dataDir, id);
								if (img) out.push({ bytes: img.bytes, ext: id.split(".").pop() ?? "png" });
							}
							return out;
						},
						// 来源之二:联网找图。同 engines 那侧的判据 —— 当前后端那格 key
						// 空着就回 null,工具跟着整个不挂。
						imageSearch: () =>
							webSearchExecutorFromSettings(deps.store.getGlobals().defaults.ai.search),
					})
				: undefined;

		return streamSSE(c, async (sse) => {
			/**
			 * 这一轮调过的工具,按**开始**的先后排 —— 那是主人眼看着它们冒出来的
			 * 顺序,落盘之后重开会话得对得上。所以 start 时就占好位子,end 只回填
			 * 成败,而不是等 end 再往后排(那样先开后完的会被插到后面去)。
			 *
			 * 落盘时只取回填过的:一条永远停在「进行中」的痕迹,在界面上就是一个
			 * 转到天荒地老的圈,而落完盘就再没有第二次机会补状态了。
			 */
			const slots: Array<{
				name: string;
				args: Record<string, string>;
				ok?: boolean;
				sources?: Array<{ title: string; url: string; siteName?: string }>;
			}> = [];
			const byId = new Map<string, (typeof slots)[number]>();
			// 思考流的账本。分片原样拼接 —— 引擎那边多轮(工具轮)的思考也走同一个
			// 回调,这里不感知轮次边界。
			let reasoning = "";

			let reply: string;
			try {
				// 聊天的思考设置与引擎(点评/总结)分了家。开关是会话级的,按消息走
				// 请求体,不带 = 关(配置里已经没有它的位置);等级始终从配置读。
				reply = await commentary.chatStatelessStream(history, {
					imageUrls: resolved.length ? resolved.map((r) => r.url) : undefined,
					thinking: {
						enableThinking: parsed.data.thinking ?? false,
						thinkingLevel: resolveChatThinkingLevel(deps.store.getGlobals().defaults.ai),
					},
					// 联网搜索同样会话级;不带 = 不开。执行器没配置时生成器静默不挂。
					// 皮肤工坊里照样透传 —— 「做套某部作品风格的皮肤」得先查得到那部
					// 作品的代表色,靠模型记忆猜配色多半是白做一趟。
					webSearch: parsed.data.search ?? false,
					...(skinTools
						? {
								extraTools: skinTools,
								systemPrompt: SKIN_MODE_SYSTEM_PROMPT,
								builtinTools: false,
							}
						: {}),
					onDelta: (text) => {
						// 不 await:回调是同步的,这里排一次写就行。真要背压也轮不到
						// 这一层管 —— SSE 的写在内存里排队,量级是几十 KB。
						void sse.writeSSE({ event: "delta", data: JSON.stringify({ text }) });
					},
					onReasoning: (text) => {
						// 先转发再记账,与 tool 事件同一个纪律:实时那一份才是这个回调
						// 存在的理由,落盘是顺带。
						void sse.writeSSE({ event: "reasoning", data: JSON.stringify({ text }) });
						reasoning += text;
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
						if (slot) {
							slot.ok = ev.ok;
							// web_search 的来源列表:落盘后重开会话还能点开「来源」。
							if (ev.sources) slot.sources = ev.sources;
						}
					},
				});
			} catch (err) {
				await sse.writeSSE({
					event: "error",
					data: JSON.stringify({ err: err instanceof Error ? err.message : String(err) }),
				});
				return;
			}

			const traces = slots.filter((s): s is AiToolTraceDTO => s.ok !== undefined);
			const updated = await store().appendMessages(conv.id, [
				// 存**能用的那些** id,不是主人递进来的原样 —— 存进去的每一个都得
				// 在盘上真实存在,否则重开会话时那几个格子就是一片碎图。
				{ role: "user", content: message, images: resolved.map((r) => r.id) },
				// reasoning 只作展示,store 会在空串时略去字段;历史回传给模型的
				// 路径(上面的 history 拼装)读的是 content,思考永不回炉。
				{ role: "assistant", content: reply, tools: traces, reasoning },
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
	/**
	 * 这一问带的图片资产 id。上限与动态点评那条路一致(4 张)—— 超了在这里就拒,
	 * 而不是悄悄截断:主人明明挑了 6 张,只有 4 张被看了却什么都不说,比报错更难查。
	 */
	images: z.array(z.string()).max(MAX_CHAT_IMAGES_PER_MESSAGE).optional(),
	/**
	 * 这一问开不开深度思考。聊天页那颗胶囊是**会话级**的(默认关、手动开、
	 * 不落盘),所以按消息走请求体;不带 = 老客户端,回落到配置里的 chat 段。
	 * 思考**等级**始终从配置读 —— 低频档位不值得每条消息驮一遍。
	 */
	thinking: z.boolean().optional(),
	/** 这一问允不允许联网搜索。同上,会话级;不带 = 不开(默认不烧钱)。 */
	search: z.boolean().optional(),
	/**
	 * 这一问在哪个模式下问的。`chat`(缺省)= 日常聊天,女仆人格 + B 站只读工具;
	 * `skin` = 皮肤工坊,人格与只读工具全收、只留 create_skin。
	 *
	 * 与思考 / 搜索同一口径:界面上那个切换是**会话级**的,不落盘,按消息走请求体。
	 * 不带 = 老客户端 = 日常聊天,写能力不会因为漏传字段而凭空出现。
	 */
	mode: z.enum(["chat", "skin"]).optional(),
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
 * 把草稿里的脱敏占位换回真实密钥。
 *
 * 页面永远看不到真 key(GET /globals 一律回占位),所以主人没改过 key 时草稿里带的
 * 就是那个占位。直接拿去请求必然 401。这里按**草稿选中的那份实例**去已存配置里
 * 取回对应桶的真 key —— 取错桶就会用 A 家的 key 打 B 家的接口。
 *
 * 主模型与视觉副模型两把各自还原:主人可能只换了其中一把。
 */
export function withStoredApiKey(draft: AISettings, stored: AISettings): AISettings {
	const id = draft.activeProfile;
	const d = draft.providers[id];
	if (!d) return draft;
	const s = stored.providers[id];
	return {
		...draft,
		providers: {
			...draft.providers,
			[id]: {
				...d,
				apiKey: resolveDraftApiKey(d.apiKey, s?.apiKey),
				vision: { ...d.vision, apiKey: resolveDraftApiKey(d.vision.apiKey, s?.vision.apiKey) },
			},
		},
	};
}

// 草稿 AI 配置 → CommentaryGeneratorConfig 的翻译住在 `runtime/ai-config.ts` ——
// 常驻 generator 与统计页的锐评用的是同一份映射。这里曾经自带一份一模一样的,
// 于是「人格该从哪儿读」有了两个答案,修一处另一处照旧。
