/**
 * 单元测试 — **作品装配** `deliverPost`(ADR-0019 决策 66):B 站动态与拓展作品共用的那一段。
 *
 * 只经公开接口:给一份 `PostEvent` + 假的 `DeliverPostDeps`(设置读口 / 渲染器 / AI / 推送 / 留痕),
 * 看发出去了什么。B 站原始数据怎么翻成作品由 `dynamic-poller.test.ts` 与 `post-from-dynamic.test.ts` 钉。
 *
 * 夹具里的 `settings` 读口按调用次数回值(`settingsSeq`):装配里「现折」「回问」是两次调用,
 * 恒回同一份的话,这两步删掉也不红。
 */

import type { ImageRenderer } from "@bilibili-notify/image";
import {
	DEFAULT_CONTENT_FILTERS,
	defaultMessageKindLayout,
	type ImageRef,
	type MessageKindLayout,
	type Post,
	type PostEvent,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	type CardFailureTracker,
	createCardFailureTracker,
	type DeliverPostDeps,
	deliverPost,
	POST_COMMENT_IMAGE_MAX_BYTES,
	POST_COMMENT_IMAGES_MAX,
	type PostSettings,
} from "../deliver-post";
import type { PostPushAnchor } from "../post-push";

type Seg = { kind: string; text?: string; buffer?: Buffer; mime?: string };

const CARD = Buffer.from("card");
const LINK = "https://example.com/post/1";
const refOf = (n: number): ImageRef => `${String(n).padStart(63, "0")}1.png`;

function postOf(over: Partial<Post> = {}): Post {
	return {
		creator: { name: "阿绫" },
		publishedAt: "2026-09-24T04:00:05.000Z",
		text: "",
		...over,
	};
}

function eventOf(over: Partial<PostEvent> = {}): PostEvent {
	return {
		subscriptionId: "s1",
		identity: { sourceKey: "fake", externalId: "x1" },
		postId: "p1",
		url: LINK,
		post: postOf(),
		...over,
	};
}

function settingsOf(over: Partial<PostSettings> = {}): PostSettings {
	return {
		filter: DEFAULT_CONTENT_FILTERS,
		messageLayout: defaultMessageKindLayout("post"),
		cardEnabled: true,
		aiEnabled: true,
		aiWebSearch: false,
		template: "{name}发布了一条动态",
		videoTemplate: "{name}发布了新视频",
		imageGroup: { enabled: false, mergeForward: false },
		...over,
	};
}

const layoutOf = (blocks: Array<{ type: string; visible?: boolean }>): MessageKindLayout => ({
	blocks: blocks.map((b, i) => ({
		id: `${b.type}-${i}`,
		type: b.type,
		visible: b.visible ?? true,
	})),
	separator: "\n",
});

interface Harness {
	event: PostEvent;
	deps: DeliverPostDeps;
	settings: ReturnType<typeof vi.fn>;
	/** 交给推送口的每一次推送(它的锚点)原样记在这儿。 */
	push: ReturnType<typeof vi.fn>;
	/** 摊开记:一个锚点里一条消息 → `(段, 角色)`。 */
	pushedMessage: ReturnType<typeof vi.fn>;
	/** 摊开记:一个锚点里几条消息(分条)→ `(段[][], 角色)`。 */
	pushedSequence: ReturnType<typeof vi.fn>;
	generatePostCard: ReturnType<typeof vi.fn>;
	comment: ReturnType<typeof vi.fn>;
	avatar: ReturnType<typeof vi.fn>;
	readImage: ReturnType<typeof vi.fn>;
	recordFiltered: ReturnType<typeof vi.fn>;
	emitEngineError: ReturnType<typeof vi.fn>;
	logs: Array<{ level: string; msg: string }>;
}

function harness(
	over: {
		event?: Partial<PostEvent>;
		post?: Partial<Post>;
		settings?: Partial<PostSettings>;
		/** 第 n 次(从 1 数)调 `settings(id)` 回什么;不给就恒回 `settings`。 */
		settingsSeq?: Array<PostSettings | undefined>;
		withImage?: boolean;
		withAi?: boolean;
		avatarRef?: ImageRef;
		images?: Map<ImageRef, { bytes: Uint8Array; mime: string }>;
		cardFailures?: CardFailureTracker;
	} = {},
): Harness {
	const pushedMessage = vi.fn(async (..._args: unknown[]) => {});
	const pushedSequence = vi.fn(async (..._args: unknown[]) => {});
	const push = vi.fn(async (_id: string, anchors: PostPushAnchor[]) => {
		for (const anchor of anchors) {
			const messages = (await anchor.messages) ?? [];
			if (messages.length === 1) await pushedMessage(messages[0], anchor.role);
			else if (messages.length > 1) await pushedSequence(messages, anchor.role);
		}
	});
	const generatePostCard = vi.fn(async (..._args: unknown[]) => CARD);
	const comment = vi.fn(async (..._args: unknown[]) => "点评");
	const avatar = vi.fn((_id: string): ImageRef | undefined => over.avatarRef);
	const readImage = vi.fn(async (ref: ImageRef) => over.images?.get(ref));
	const recordFiltered = vi.fn();
	const emitEngineError = vi.fn();
	const logs: Harness["logs"] = [];
	const rec = (level: string) => (msg: unknown) => {
		logs.push({ level, msg: String(msg) });
	};
	const fixed = settingsOf(over.settings);
	let calls = 0;
	const settings = vi.fn((_id: string) => {
		const n = calls++;
		return over.settingsSeq ? over.settingsSeq[Math.min(n, over.settingsSeq.length - 1)] : fixed;
	});
	const image = { generatePostCard } as unknown as ImageRenderer;
	const deps: DeliverPostDeps = {
		logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") },
		settings,
		image: () => (over.withImage === false ? undefined : image),
		ai: () => (over.withAi === false || over.withAi === undefined ? undefined : { comment }),
		cardFailures: over.cardFailures ?? createCardFailureTracker(),
		avatar,
		readImage,
		push,
		recordFiltered,
		emitEngineError,
	} as unknown as DeliverPostDeps;
	return {
		event: eventOf({ ...over.event, post: postOf(over.post) }),
		deps,
		settings,
		push,
		pushedMessage,
		pushedSequence,
		generatePostCard,
		comment,
		avatar,
		readImage,
		recordFiltered,
		emitEngineError,
		logs,
	};
}

const run = (h: Harness): Promise<void> => deliverPost(h.event, h.deps);
const segsOf = (h: Harness, call = 0): Seg[] => h.pushedMessage.mock.calls[call]?.[0] as Seg[];
/** 交给推送口的本体锚点(第一次推送的第一个锚点)。 */
const mainAnchorOf = (h: Harness): PostPushAnchor =>
	(h.push.mock.calls[0]?.[1] as PostPushAnchor[] | undefined)?.[0] as PostPushAnchor;
/** 本体锚点的 AI 版里第一条消息的段;没有 AI 版就是 `undefined`。 */
const aiSegsOf = (h: Harness): Seg[] =>
	(mainAnchorOf(h).aiMessages as Array<Seg[]> | undefined)?.[0] as Seg[];
/** 第 n 次出卡时交给出卡器的那份作品。 */
const cardPostOf = (h: Harness, call: number): Post =>
	h.generatePostCard.mock.calls[call]?.[0] as Post;
/** 图集锚点里的那个 image-group 段。 */
const groupOf = (
	anchor: PostPushAnchor | undefined,
): { images: unknown[]; mergeForward: boolean } => {
	const messages = anchor?.messages as Array<Array<{ images: unknown[]; mergeForward: boolean }>>;
	return messages[0]?.[0] as { images: unknown[]; mergeForward: boolean };
};

describe("deliverPost — 按版式装配", () => {
	it("默认版式:卡片 + 模板文字与链接同条,是这次推送的本体,只交一次,带订阅 id", async () => {
		const h = harness();
		await run(h);
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(h.push.mock.calls[0]?.[0]).toBe("s1");
		expect(h.pushedMessage).toHaveBeenCalledTimes(1);
		const [segs, role] = h.pushedMessage.mock.calls[0] as [Seg[], string];
		expect(role).toBe("main");
		expect(segs.map((s) => s.kind)).toEqual(["image", "text"]);
		expect(segs[0]).toMatchObject({ buffer: CARD, mime: "image/jpeg" });
		expect(segs[1]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
	});

	it("分条符切两条 → 走序列发送", async () => {
		const h = harness({
			settings: {
				messageLayout: layoutOf([{ type: "card" }, { type: "split" }, { type: "text" }]),
			},
		});
		await run(h);
		expect(h.pushedMessage).not.toHaveBeenCalled();
		const [messages, role] = h.pushedSequence.mock.calls[0] as [Seg[][], string];
		expect(role).toBe("main");
		expect(messages.map((m) => m.map((s) => s.kind))).toEqual([["image"], ["text"]]);
	});

	it("链接为空串 → 链接部件缺席", async () => {
		const h = harness({ withImage: false, event: { url: "" } });
		await run(h);
		expect(segsOf(h)).toEqual([{ kind: "text", text: "阿绫发布了一条动态" }]);
	});

	it("全部块藏起来 → 一条都不发;对照:同样的铺垫默认版式就出卡、点评、推送", async () => {
		const hidden = harness({
			withAi: true,
			post: { text: "正文" },
			settings: {
				messageLayout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text", visible: false },
					{ type: "link", visible: false },
				]),
			},
		});
		await run(hidden);
		// 没有本体、也没有图集:连推送口都不调。
		expect(hidden.push).not.toHaveBeenCalled();
		expect(hidden.generatePostCard).not.toHaveBeenCalled();
		expect(hidden.comment).not.toHaveBeenCalled();

		const shown = harness({ withAi: true, post: { text: "正文" } });
		await run(shown);
		expect(shown.push).toHaveBeenCalledTimes(1);
		expect(shown.generatePostCard).toHaveBeenCalledTimes(1);
		expect(shown.comment).toHaveBeenCalledTimes(1);
	});
});

describe("deliverPost — 出卡", () => {
	it("出卡器收到这条作品(同一份内容)与这条订阅的皮肤 id", async () => {
		const h = harness({ post: { text: "正文" }, settings: { cardSkin: "skin-1" } });
		await run(h);
		expect(h.generatePostCard).toHaveBeenCalledWith(h.event.post, { cardSkin: "skin-1" });
	});

	// per-UP 旋钮覆盖(ADR-0014 决策 17 的 🔗)跟皮肤 id 同路。B 站动态与拓展作品都经这里出卡。
	// 验红:把 deliver-post.ts 里递 `cardSkinKnobs` 那一句删掉,这条红。
	it("这条订阅的旋钮覆盖随皮肤一起交给出卡", async () => {
		const cardSkinKnobs = { "skin-1": { accent: "#aaaaaa" } };
		const h = harness({ settings: { cardSkin: "skin-1", cardSkinKnobs } });
		await run(h);
		expect(h.generatePostCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "skin-1", cardSkinKnobs });
	});

	it("关了出图 / 没有渲染器 / 版式藏起卡片 → 不出卡,纯文字;对照:默认就出卡", async () => {
		const cases = [
			harness({ settings: { cardEnabled: false } }),
			harness({ withImage: false }),
			harness({
				settings: { messageLayout: layoutOf([{ type: "card", visible: false }, { type: "text" }]) },
			}),
		];
		for (const h of cases) {
			await run(h);
			expect(h.generatePostCard).not.toHaveBeenCalled();
			expect(segsOf(h).map((s) => s.kind)).toEqual(["text"]);
		}
		const control = harness();
		await run(control);
		expect(control.generatePostCard).toHaveBeenCalledTimes(1);
		expect(segsOf(control).map((s) => s.kind)).toEqual(["image", "text"]);
	});

	it("出卡失败 → 降级纯文字照发", async () => {
		const h = harness();
		h.generatePostCard.mockRejectedValueOnce(new Error("boom"));
		await run(h);
		expect(segsOf(h)).toEqual([{ kind: "text", text: `阿绫发布了一条动态\n${LINK}` }]);
	});

	it("渲染器与 AI 每条现取:热换之后下一条用新的,不是攥着第一次的", async () => {
		const first = harness({ withAi: true, post: { text: "正文" } });
		await run(first);
		expect(first.generatePostCard).toHaveBeenCalledTimes(1);
		expect(first.comment).toHaveBeenCalledTimes(1);

		// 同一套 deps、换一个渲染器 / AI:`image()` / `ai()` 是读外层变量的闭包。
		const fakeRenderer = (): ImageRenderer =>
			({ generatePostCard: vi.fn(async () => CARD) }) as unknown as ImageRenderer;
		const fakeProvider = (note: string) => ({ comment: vi.fn(async () => note) });
		let renderer: ImageRenderer | undefined = fakeRenderer();
		let provider: ReturnType<typeof fakeProvider> | undefined = fakeProvider("旧");
		const deps: DeliverPostDeps = {
			...first.deps,
			image: () => renderer,
			ai: () => provider as never,
		};
		const oldRenderer = renderer;
		const oldProvider = provider;
		await deliverPost(first.event, deps);
		expect(oldRenderer?.generatePostCard).toHaveBeenCalledTimes(1);
		expect(oldProvider?.comment).toHaveBeenCalledTimes(1);

		const newRenderer = fakeRenderer();
		const newProvider = fakeProvider("新");
		renderer = newRenderer;
		provider = newProvider;
		await deliverPost(first.event, deps);
		expect(newRenderer.generatePostCard).toHaveBeenCalledTimes(1);
		expect(newProvider.comment).toHaveBeenCalledTimes(1);
		expect(oldRenderer?.generatePostCard).toHaveBeenCalledTimes(1);

		// 撤掉(置空)之后:不出卡、不点评,纯文字。
		renderer = undefined;
		provider = undefined;
		const before = first.push.mock.calls.length;
		await deliverPost(first.event, deps);
		expect(newRenderer.generatePostCard).toHaveBeenCalledTimes(1);
		expect(newProvider.comment).toHaveBeenCalledTimes(1);
		expect(first.push.mock.calls.length).toBe(before + 1);
	});
});

describe("deliverPost — 外层作者的头像", () => {
	it("作品没带头像 → 出卡那一刻按订阅 id 现读补上;入参那份作品不被改", async () => {
		const ref = refOf(5);
		const h = harness({ avatarRef: ref });
		await run(h);
		expect(h.avatar).toHaveBeenCalledWith("s1");
		const handed = h.generatePostCard.mock.calls[0]?.[0] as Post;
		expect(handed.creator).toEqual({ name: "阿绫", avatar: ref });
		expect(h.event.post.creator.avatar).toBeUndefined();
	});

	it("作品自己带了头像 → 用它,订阅资料里的不盖上去;对照:没带才补", async () => {
		const own = refOf(1);
		const h = harness({ avatarRef: refOf(5), post: { creator: { name: "阿绫", avatar: own } } });
		await run(h);
		const handed = h.generatePostCard.mock.calls[0]?.[0] as Post;
		expect(handed.creator.avatar).toBe(own);
	});

	it("资料里也没有头像 → 照常出卡,头像缺着", async () => {
		const h = harness();
		await run(h);
		const handed = h.generatePostCard.mock.calls[0]?.[0] as Post;
		expect(handed.creator.avatar).toBeUndefined();
		expect(h.generatePostCard).toHaveBeenCalledTimes(1);
	});

	it("头像每张卡现读:读口背后换了引用,下一张就用新的", async () => {
		let current: ImageRef | undefined;
		const h = harness();
		h.deps.avatar = () => current;
		await run(h);
		expect(cardPostOf(h, 0).creator.avatar).toBeUndefined();
		current = refOf(7);
		await run(h);
		expect(cardPostOf(h, 1).creator.avatar).toBe(refOf(7));
	});
});

describe("deliverPost — 出图连续失败只提醒一次", () => {
	const failing = (h: Harness) => h.generatePostCard.mockRejectedValue(new Error("chrome crash"));

	it("头一次失败:只发一次组件告警(没有直发私聊),计数 1;同一串再失败不再提醒", async () => {
		const tracker = createCardFailureTracker();
		const h = harness({ cardFailures: tracker });
		failing(h);
		await run(h);
		expect(tracker.streak).toBe(1);
		expect(h.emitEngineError).toHaveBeenCalledWith(
			"生成动态图片失败：chrome crash，已降级为纯文字推送，请检查图片插件状态",
		);

		await run(h);
		expect(tracker.streak).toBe(2);
		expect(h.emitEngineError).toHaveBeenCalledTimes(1);
	});

	it("两条路共用一份计数:一条路提醒过,另一条路同一串失败不再提醒", async () => {
		const tracker = createCardFailureTracker();
		const bili = harness({ cardFailures: tracker });
		const ext = harness({ cardFailures: tracker });
		failing(bili);
		failing(ext);
		await run(bili);
		await run(ext);
		expect(tracker.streak).toBe(2);
		expect(bili.emitEngineError).toHaveBeenCalledTimes(1);
		expect(ext.emitEngineError).not.toHaveBeenCalled();
	});

	it("并发的几条失败同一串只提醒一次", async () => {
		const tracker = createCardFailureTracker();
		const a = harness({ cardFailures: tracker });
		const b = harness({ cardFailures: tracker });
		failing(a);
		failing(b);
		await Promise.all([run(a), run(b)]);
		expect(tracker.streak).toBe(2);
		expect(a.emitEngineError.mock.calls.length + b.emitEngineError.mock.calls.length).toBe(1);
		expect(tracker.notified).toBe(true);
	});

	it("告警发射同步抛了 → 不算提醒过,记一条 warn,下一次失败再提醒", async () => {
		const tracker = createCardFailureTracker();
		const h = harness({ cardFailures: tracker });
		failing(h);
		h.emitEngineError.mockImplementationOnce(() => {
			throw new Error("bus down");
		});
		await run(h);
		expect(tracker.notified).toBe(false);
		expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("bus down"))).toBe(true);
		await run(h);
		expect(h.emitEngineError).toHaveBeenCalledTimes(2);
		expect(tracker.notified).toBe(true);
	});

	it("出卡恢复 → 复位并记一句恢复;之后再失败能再提醒", async () => {
		const tracker = createCardFailureTracker();
		const bad = harness({ cardFailures: tracker });
		failing(bad);
		await run(bad);
		const good = harness({ cardFailures: tracker });
		await run(good);
		expect(tracker.streak).toBe(0);
		expect(tracker.notified).toBe(false);
		expect(good.logs.some((l) => l.level === "info" && l.msg.includes("之前连续失败 1 次"))).toBe(
			true,
		);
		const badAgain = harness({ cardFailures: tracker });
		failing(badAgain);
		await run(badAgain);
		expect(badAgain.emitEngineError).toHaveBeenCalledTimes(1);
	});
});

describe("deliverPost — 模板", () => {
	it("视频走视频模板,别的走动态模板", async () => {
		const video = harness({
			withImage: false,
			post: { video: { cover: {}, title: "标题", description: "" } },
		});
		await run(video);
		expect(segsOf(video)[0]?.text).toBe(`阿绫发布了新视频\n${LINK}`);
		const plain = harness({ withImage: false });
		await run(plain);
		expect(segsOf(plain)[0]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
	});

	it("设置里的模板就是用的模板;`\\n` 展开成换行", async () => {
		const h = harness({
			withImage: false,
			settings: { template: "全局 {name}\\n第二行" },
		});
		await run(h);
		expect(segsOf(h)[0]?.text).toBe(`全局 阿绫\n第二行\n${LINK}`);
	});
});

describe("deliverPost — AI 点评", () => {
	it("点评替换模板文字;提示词带叫法与正文,这条订阅的 AI 覆盖原样交过去;叫法缺省「作品」", async () => {
		const aiOverride = { dynamicPrompt: "这位 UP 专属的场景提示" };
		const custom = harness({
			withImage: false,
			withAi: true,
			event: { postNoun: "作品" },
			post: { text: "正文" },
			settings: { aiOverride },
		});
		await run(custom);
		expect(custom.comment).toHaveBeenCalledWith(
			"阿绫发布了一条作品，内容如下：\n正文",
			"dynamic",
			[],
			aiOverride,
		);
		// 模板版照发,点评是另一份:交给推送层按目标挑。
		expect(segsOf(custom)[0]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
		expect(aiSegsOf(custom)[0]?.text).toBe(`点评\n${LINK}`);

		const dflt = harness({ withImage: false, withAi: true, post: { text: "正文" } });
		await run(dflt);
		expect(dflt.comment.mock.calls[0]?.[0]).toBe("阿绫发布了一条作品，内容如下：\n正文");
	});

	it("提示词里的正文是 postText(labeled):标题 / 视频标题 / 转发原文都在", async () => {
		const h = harness({
			withImage: false,
			withAi: true,
			post: {
				text: "今天发新歌",
				article: { title: "专栏题" },
				video: { cover: {}, title: "新歌 MV", description: "" },
				repost: postOf({ creator: { name: "原作者" }, text: "原文" }),
			},
		});
		await run(h);
		expect(h.comment.mock.calls[0]?.[0]).toBe(
			"阿绫发布了一条作品，内容如下：\n标题：专栏题\n今天发新歌\n视频标题：新歌 MV\n（转发自 原作者：原文）",
		);
	});

	it("联网搜索开着 → override 带 webSearch:true;对照:没开就不带", async () => {
		const on = harness({
			withAi: true,
			post: { text: "正文" },
			settings: { aiWebSearch: true, aiOverride: { dynamicPrompt: "专属" } },
		});
		await run(on);
		expect(on.comment.mock.calls[0]?.[3]).toEqual({ dynamicPrompt: "专属", webSearch: true });

		const off = harness({
			withAi: true,
			post: { text: "正文" },
			settings: { aiOverride: { dynamicPrompt: "专属" } },
		});
		await run(off);
		expect(off.comment.mock.calls[0]?.[3]).toEqual({ dynamicPrompt: "专属" });
	});

	it("没有可点评的正文 / 关了 AI / 文字块藏起来 → 不调 AI;对照:有正文、开着就调", async () => {
		const cases = [
			harness({ withAi: true }),
			harness({ withAi: true, post: { text: "正文" }, settings: { aiEnabled: false } }),
			harness({
				withAi: true,
				post: { text: "正文" },
				settings: { messageLayout: layoutOf([{ type: "card" }, { type: "text", visible: false }]) },
			}),
		];
		for (const h of cases) {
			await run(h);
			expect(h.comment).not.toHaveBeenCalled();
		}
		const control = harness({ withAi: true, post: { text: "正文" } });
		await run(control);
		expect(control.comment).toHaveBeenCalledTimes(1);
	});

	it("点评失败 → 回退模板文字照发", async () => {
		const h = harness({ withImage: false, withAi: true, post: { text: "正文" } });
		h.comment.mockRejectedValueOnce(new Error("额度用完"));
		await run(h);
		expect(segsOf(h)[0]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
		// 没有 AI 版:键缺失,不是 undefined 值。
		expect("aiMessages" in mainAnchorOf(h)).toBe(false);
		expect(h.logs.some((l) => l.level === "error" && l.msg.includes("额度用完"))).toBe(true);
	});

	it("生成了点评:本体锚点带两份,messages 是模板那一串、aiMessages 是点评那一串,卡片两份都在;只调一次 AI", async () => {
		const h = harness({ withAi: true, post: { text: "正文" } });
		await run(h);
		expect(h.comment).toHaveBeenCalledTimes(1);
		expect(mainAnchorOf(h).role).toBe("main");
		expect(segsOf(h)).toEqual([
			{ kind: "image", buffer: CARD, mime: "image/jpeg" },
			{ kind: "text", text: `阿绫发布了一条动态\n${LINK}` },
		]);
		expect(aiSegsOf(h)).toEqual([
			{ kind: "image", buffer: CARD, mime: "image/jpeg" },
			{ kind: "text", text: `点评\n${LINK}` },
		]);
	});

	it("生成门折出来是关(没人用得上点评)→ 不调 AI,锚点上没有 aiMessages 这一格", async () => {
		const h = harness({ withAi: true, post: { text: "正文" }, settings: { aiEnabled: false } });
		await run(h);
		expect(h.comment).not.toHaveBeenCalled();
		expect("aiMessages" in mainAnchorOf(h)).toBe(false);
	});

	it("文字块藏起来 → 不调 AI、也没有 aiMessages", async () => {
		const h = harness({
			withAi: true,
			post: { text: "正文" },
			settings: { messageLayout: layoutOf([{ type: "card" }, { type: "text", visible: false }]) },
		});
		await run(h);
		expect(h.comment).not.toHaveBeenCalled();
		expect("aiMessages" in mainAnchorOf(h)).toBe(false);
	});

	it("视频作品:messages 用视频模板,aiMessages 是点评", async () => {
		const h = harness({
			withImage: false,
			withAi: true,
			post: { text: "正文", video: { cover: {}, title: "新歌", description: "" } },
		});
		await run(h);
		expect(segsOf(h)[0]?.text).toBe(`阿绫发布了新视频\n${LINK}`);
		expect(aiSegsOf(h)[0]?.text).toBe(`点评\n${LINK}`);
	});

	it("点评回来是空串或只有空白:当作没有 AI 版,不挂 aiMessages,所有目标收模板", async () => {
		for (const empty of ["", "  \n\t "]) {
			const h = harness({ withImage: false, withAi: true, post: { text: "正文" } });
			h.comment.mockResolvedValueOnce(empty);
			await run(h);
			expect(h.comment).toHaveBeenCalledTimes(1);
			expect(segsOf(h)[0]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
			expect("aiMessages" in mainAnchorOf(h)).toBe(false);
		}
	});
});

describe("deliverPost — AI 看的图", () => {
	const commentImages = (h: Harness): unknown => h.comment.mock.calls[0]?.[2];

	it("有公网网址的图给网址(服务商自己去拉),不读图库;次序:配图 → 文章配图 → 视频封面", async () => {
		const h = harness({
			withImage: false,
			withAi: true,
			post: {
				text: "正文",
				images: [{ url: "http://a/1.jpg" }],
				article: { title: "t", images: [{ url: "http://a/2.jpg" }] },
				video: { cover: { url: "http://a/3.jpg" }, title: "v", description: "" },
			},
		});
		await run(h);
		expect(commentImages(h)).toEqual(["http://a/1.jpg", "http://a/2.jpg", "http://a/3.jpg"]);
		expect(h.readImage).not.toHaveBeenCalled();
	});

	it("又有网址又有引用 → 网址优先(B 站抓图之后两样都有)", async () => {
		const h = harness({
			withImage: false,
			withAi: true,
			post: { text: "正文", images: [{ url: "http://a/1.jpg", ref: refOf(1) }] },
		});
		await run(h);
		expect(commentImages(h)).toEqual(["http://a/1.jpg"]);
		expect(h.readImage).not.toHaveBeenCalled();
	});

	it("只有图库引用的图:读出字节编成 data URL(mime 照图库给的)", async () => {
		const bytes = Uint8Array.from([1, 2, 3]);
		const h = harness({
			withImage: false,
			withAi: true,
			post: { text: "正文", images: [{ ref: refOf(1) }] },
			images: new Map([[refOf(1), { bytes, mime: "image/png" }]]),
		});
		await run(h);
		expect(h.readImage).toHaveBeenCalledWith(refOf(1));
		expect(commentImages(h)).toEqual([
			`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
		]);
	});

	it("单张超过 3 MiB 跳过让后面的顶上;图库里已经没有的图也跳过", async () => {
		const huge = new Uint8Array(POST_COMMENT_IMAGE_MAX_BYTES + 1);
		const small = Uint8Array.from([9]);
		const h = harness({
			withImage: false,
			withAi: true,
			post: {
				text: "正文",
				images: [{ ref: refOf(1) }, { ref: refOf(2) }, { ref: refOf(3) }],
			},
			images: new Map([
				[refOf(1), { bytes: huge, mime: "image/png" }],
				// refOf(2) 不在图库里
				[refOf(3), { bytes: small, mime: "image/png" }],
			]),
		});
		await run(h);
		expect(commentImages(h)).toEqual([
			`data:image/png;base64,${Buffer.from(small).toString("base64")}`,
		]);

		// 对照:恰好 3 MiB 的不算超。
		const exact = new Uint8Array(POST_COMMENT_IMAGE_MAX_BYTES);
		const edge = harness({
			withImage: false,
			withAi: true,
			post: { text: "正文", images: [{ ref: refOf(1) }] },
			images: new Map([[refOf(1), { bytes: exact, mime: "image/png" }]]),
		});
		await run(edge);
		expect(commentImages(edge)).toHaveLength(1);
	});

	it("最多 4 张,多的不读", async () => {
		const images = Array.from({ length: 6 }, (_, i) => ({ url: `http://a/${i}.jpg` }));
		const h = harness({ withImage: false, withAi: true, post: { text: "正文", images } });
		await run(h);
		expect(POST_COMMENT_IMAGES_MAX).toBe(4);
		expect(commentImages(h)).toEqual(images.slice(0, 4).map((i) => i.url));

		// 引用的图凑够 4 张就不再读后面的。
		const bytes = Uint8Array.from([1]);
		const refs = Array.from({ length: 6 }, (_, i) => refOf(i + 1));
		const byRef = harness({
			withImage: false,
			withAi: true,
			post: { text: "正文", images: refs.map((ref) => ({ ref })) },
			images: new Map(refs.map((ref) => [ref, { bytes, mime: "image/png" }])),
		});
		await run(byRef);
		expect(commentImages(byRef)).toHaveLength(4);
		expect(byRef.readImage).toHaveBeenCalledTimes(4);
	});

	it("转发的原作品里的图不算(只看最外层)", async () => {
		const h = harness({
			withImage: false,
			withAi: true,
			post: {
				text: "正文",
				repost: postOf({ text: "原文", images: [{ url: "http://a/inner.jpg" }] }),
			},
		});
		await run(h);
		expect(commentImages(h)).toEqual([]);
	});

	// 验红:把 deliver-post.ts `commentImagesOf` 里 `typeof image.url === "string"` 的守卫去掉,这条红(对象被当网址喂给 AI)。
	it("某张图的 url 运行时是个对象(接口出了没见过的形状)→ 不进 AI 的图、也不抛;别的图照常", async () => {
		const h = harness({
			withImage: false,
			withAi: true,
			post: {
				text: "正文",
				images: [{ url: { bad: true } as never }, { url: "http://a/ok.jpg" }],
			},
		});
		await run(h);
		expect(commentImages(h)).toEqual(["http://a/ok.jpg"]);
		expect(h.push).toHaveBeenCalledTimes(1);
	});
});

describe("deliverPost — 现折与回问", () => {
	it("开头现折一次设置:订阅不在 / 停用 / 开关关着(读口回 undefined)→ 什么都不做;对照:回了设置就推", async () => {
		const gone = harness({ settingsSeq: [undefined], withAi: true, post: { text: "正文" } });
		await run(gone);
		expect(gone.settings).toHaveBeenCalledWith("s1");
		expect(gone.generatePostCard).not.toHaveBeenCalled();
		expect(gone.comment).not.toHaveBeenCalled();
		expect(gone.push).not.toHaveBeenCalled();
		expect(gone.recordFiltered).not.toHaveBeenCalled();

		const here = harness({ withAi: true, post: { text: "正文" } });
		await run(here);
		expect(here.push).toHaveBeenCalledTimes(1);
	});

	it("用的是开头折的那一份:回问时读口回了别的模板,发出去的文字仍是第一份的", async () => {
		const first = settingsOf({ template: "第一份 {name}" });
		const later = settingsOf({ template: "第三份 {name}" });
		const h = harness({ withImage: false, settingsSeq: [first, later, later] });
		await run(h);
		expect(segsOf(h)[0]?.text).toBe(`第一份 阿绫\n${LINK}`);
	});

	it("出卡之后回问:期间订阅被停用(读口第二次回 undefined)→ 不发主卡也不发图集;出卡已经出过", async () => {
		const on = settingsOf({ imageGroup: { enabled: true, mergeForward: false } });
		const h = harness({
			post: { images: [{ url: "http://a/1.jpg" }] },
			settingsSeq: [on, undefined],
		});
		await run(h);
		expect(h.generatePostCard).toHaveBeenCalledTimes(1); // 回问排在出卡之后
		expect(h.push).not.toHaveBeenCalled();
		expect(h.settings).toHaveBeenCalledTimes(2);
	});

	it("回问排在点评之后:点评途中订阅没了 → 点评已调、推送没发", async () => {
		const on = settingsOf();
		const h = harness({
			withImage: false,
			withAi: true,
			post: { text: "正文" },
			settingsSeq: [on, undefined],
		});
		await run(h);
		expect(h.comment).toHaveBeenCalledTimes(1);
		expect(h.push).not.toHaveBeenCalled();
	});

	it("回问时订阅好端端的(读口两次都回设置)→ 照推,读口恰好问了两次", async () => {
		const h = harness({ settingsSeq: [settingsOf(), settingsOf()] });
		await run(h);
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(h.settings).toHaveBeenCalledTimes(2);
	});
});

describe("deliverPost — 过滤", () => {
	const blockWord = settingsOf({
		filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["广告"] },
	});

	it("命中过滤 → 留痕(订阅 id / 原因 / 整条文字 / 地址),不出卡、不点评、不推送", async () => {
		const h = harness({
			withAi: true,
			post: { text: "来看看广告" },
			settings: blockWord,
		});
		await run(h);
		expect(h.recordFiltered).toHaveBeenCalledWith({
			subscriptionId: "s1",
			filteredBy: "blocked-keyword",
			text: "来看看广告",
			url: LINK,
		});
		expect(h.generatePostCard).not.toHaveBeenCalled();
		expect(h.comment).not.toHaveBeenCalled();
		expect(h.push).not.toHaveBeenCalled();
	});

	it("对照:同样的铺垫,正文里没有屏蔽词 → 不留痕,出卡、点评、推送都发生", async () => {
		const h = harness({ withAi: true, post: { text: "正常内容" }, settings: blockWord });
		await run(h);
		expect(h.recordFiltered).not.toHaveBeenCalled();
		expect(h.generatePostCard).toHaveBeenCalledTimes(1);
		expect(h.comment).toHaveBeenCalledTimes(1);
		expect(h.push).toHaveBeenCalledTimes(1);
	});

	it("类型开关只看最外层:blockVideos 拦视频作品;转发里的视频不归它管(照推)", async () => {
		const block = settingsOf({ filter: { ...DEFAULT_CONTENT_FILTERS, blockVideos: true } });
		const video = harness({
			settings: block,
			post: { video: { cover: {}, title: "v", description: "" } },
		});
		await run(video);
		expect(video.recordFiltered).toHaveBeenCalledWith(
			expect.objectContaining({ filteredBy: "blocked-videos" }),
		);
		expect(video.push).not.toHaveBeenCalled();

		const repost = harness({
			settings: block,
			post: { repost: postOf({ video: { cover: {}, title: "v", description: "" } }) },
		});
		await run(repost);
		expect(repost.recordFiltered).not.toHaveBeenCalled();
		expect(repost.push).toHaveBeenCalledTimes(1);
	});

	it("留痕的文字是过滤看的那一份(含被转发的原作品里的字)", async () => {
		const h = harness({
			settings: blockWord,
			post: { text: "外层", repost: postOf({ text: "原文里有广告" }) },
		});
		await run(h);
		expect(h.recordFiltered.mock.calls[0]?.[0]).toMatchObject({ text: "外层\n原文里有广告" });
	});

	it("留痕抛错不连累:记一条 warn,装配不往外抛、也不推送", async () => {
		const h = harness({ post: { text: "广告" }, settings: blockWord });
		h.recordFiltered.mockImplementationOnce(() => {
			throw new Error("历史写不进");
		});
		await expect(run(h)).resolves.toBeUndefined();
		expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("历史写不进"))).toBe(true);
		expect(h.push).not.toHaveBeenCalled();
	});
});

describe("deliverPost — 发送失败与图集", () => {
	const galleryImages = [
		{ url: "http://a/1.jpg", width: 800, height: 600 },
		{ url: "http://a/2.jpg", width: 800, height: 600 },
	];
	const groupOn = (mergeForward: boolean) => ({ imageGroup: { enabled: true, mergeForward } });

	it("推送口抛错(本体没交出去)→ 往外抛,由入口接住", async () => {
		const h = harness({ post: { images: galleryImages }, settings: groupOn(false) });
		h.push.mockRejectedValueOnce(new Error("bot 掉线"));
		await expect(run(h)).rejects.toThrow("bot 掉线");
		expect(h.push).toHaveBeenCalledTimes(1);
	});

	it("图集与主卡是同一次推送:只交一次,本体在前,图集是不带键的附加项锚点", async () => {
		const h = harness({ post: { images: galleryImages }, settings: groupOn(true) });
		await run(h);
		expect(h.push).toHaveBeenCalledTimes(1);
		const [, anchors] = h.push.mock.calls[0] as [string, PostPushAnchor[]];
		// 图集掉成本体就会再 @ 一次全体;带上键就会被附加项的三态表收窄。
		expect(anchors.map((a) => [a.role, a.extra])).toEqual([
			["main", undefined],
			["extra", undefined],
		]);
		expect(anchors[1]?.messages).toEqual([
			[{ kind: "image-group", mergeForward: true, images: galleryImages }],
		]);
	});

	it("图集的元素只有 url / 宽 / 高三格:引用、动图标记不递给适配器", async () => {
		const h = harness({
			post: {
				images: [
					{ url: "http://a/1.jpg", ref: refOf(1), width: 8, height: 6, isAnimated: true },
					{ url: "http://a/2.jpg", ref: refOf(2) },
				],
			},
			settings: groupOn(false),
		});
		await run(h);
		const [, anchors] = h.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(groupOf(anchors[1]).images).toStrictEqual([
			{ url: "http://a/1.jpg", width: 8, height: 6 },
			{ url: "http://a/2.jpg", width: undefined, height: undefined },
		]);
	});

	it("只有带公网网址的图进图集:只有图库引用的(拓展作品)没有图集,混着的只取带网址的", async () => {
		const onlyRefs = harness({
			post: { images: [{ ref: refOf(1) }, { ref: refOf(2) }] },
			settings: groupOn(false),
		});
		await run(onlyRefs);
		const [, mainOnly] = onlyRefs.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(mainOnly.map((a) => a.role)).toEqual(["main"]);

		const mixed = harness({
			post: { images: [{ ref: refOf(1) }, { url: "http://a/2.jpg", ref: refOf(2) }] },
			settings: groupOn(true),
		});
		await run(mixed);
		const [, anchors] = mixed.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(anchors.map((a) => a.role)).toEqual(["main", "extra"]);
		expect(groupOf(anchors[1]).images).toHaveLength(1);
		// 只剩一张 → 不走合并转发。
		expect(groupOf(anchors[1]).mergeForward).toBe(false);
	});

	it("带图的转发 / 文字动态也附图集(外层有图就附);不带图的文字动态没有 —— 开关开着的前提下", async () => {
		const withImages = harness({
			post: { text: "转发语", repost: postOf({ text: "原文" }), images: galleryImages },
			settings: groupOn(false),
		});
		await run(withImages);
		const [, anchors] = withImages.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(anchors.map((a) => a.role)).toEqual(["main", "extra"]);

		const none = harness({ post: { text: "只有字" }, settings: groupOn(false) });
		await run(none);
		const [, noneAnchors] = none.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(noneAnchors.map((a) => a.role)).toEqual(["main"]);
	});

	it("被转发的原作品里的图不进图集(只看最外层)", async () => {
		const h = harness({
			post: { repost: postOf({ images: galleryImages }) },
			settings: groupOn(false),
		});
		await run(h);
		const [, anchors] = h.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(anchors.map((a) => a.role)).toEqual(["main"]);
	});

	it("版式把主卡的部件全藏了、图集开着 → 只交图集那一个附加项锚点", async () => {
		const h = harness({
			post: { images: galleryImages },
			settings: {
				...groupOn(false),
				messageLayout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text", visible: false },
					{ type: "link", visible: false },
				]),
			},
		});
		await run(h);
		const [, anchors] = h.push.mock.calls[0] as [string, PostPushAnchor[]];
		expect(anchors.map((a) => a.role)).toEqual(["extra"]);
	});

	it("单张图不走合并转发;开关关着不附;多张且开着合并转发才合并", async () => {
		const single = harness({
			post: { images: [{ url: "http://a/1.jpg" }] },
			settings: groupOn(true),
		});
		await run(single);
		expect((segsOf(single, 1)[0] as { mergeForward?: boolean }).mergeForward).toBe(false);

		const off = harness({
			post: { images: galleryImages },
			settings: { imageGroup: { enabled: false, mergeForward: false } },
		});
		await run(off);
		expect(off.pushedMessage).toHaveBeenCalledTimes(1);

		const many = harness({ post: { images: galleryImages }, settings: groupOn(true) });
		await run(many);
		expect((segsOf(many, 1)[0] as { mergeForward?: boolean }).mergeForward).toBe(true);
	});
});
