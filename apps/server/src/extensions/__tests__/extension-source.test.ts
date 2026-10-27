/**
 * 拓展订阅源的宿主适配(`createExtensionSource`):拓展交回的一切都当外来数据,只在这一处收。
 *
 * 钉在公开口上:造出来的核心 `Source` 的 `start` / `searchCreators` / `fetchProfile` / `fetchLiveStatus` / `stop`,
 * 以及 `start` 时递给拓展的那面 ctx 上的三种上报。核心那一份上下文换成一个只记「收到了什么」的替身 ——
 * 这里要看的是递过去的东西长什么样(ISO → 统一成 UTC、图库引用 → `PostImage`、名字补链),不是核心怎么展开订阅。
 *
 * 期望值都是手写的字面量(时刻的 ISO 串、拒收原因里点名的格),不拿实现的换算式去算。
 */

import {
	type CreatorProfileReport,
	type ExtensionManifest,
	type LiveSignalReport,
	type Logger,
	type PostReport,
	parseExtensionManifest,
	type SourceContext,
} from "@bilibili-notify/internal";
import type {
	ExtensionLiveSignalReport,
	ExtensionPostReport,
	ExtensionSourceContext,
	SourceDef,
} from "@bilibili-notify/internal/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { readSourceHealth } from "../../runtime/status-command.js";
import { subscriptionIdentityLabelOf } from "../../subscriptions/platform-label.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import { createExtensionSource, type ExtensionSourceDiscrepancy } from "../extension-source.js";

const REF = `${"a".repeat(64)}.png`;
const REF_B = `${"b".repeat(64)}.jpg`;
const T_ISO = "2026-09-23T12:00:00.000Z";
const T_OFFSET = "2026-09-23T20:00:00+08:00";
/** 下播没交 `endedAt` 时取的「到达那一刻」。 */
const ARRIVED = Date.UTC(2026, 8, 23, 14);
const ARRIVED_ISO = "2026-09-23T14:00:00.000Z";

function manifestOf(
	supportedFeatures: string[] = ["post", "liveStart", "liveEnd"],
	externalIdNoun?: string,
	creatorNoun?: string,
): ExtensionManifest {
	const read = parseExtensionManifest({
		id: "douyin",
		name: "抖音拓展",
		description: "测试用",
		version: "0.1.0",
		apiVersion: 3,
		contributes: {
			subscription: {
				label: "抖音",
				shortLabel: "抖",
				color: "#fe2c55",
				postNoun: "作品",
				externalIdRegex: "[a-z0-9-]+",
				...(externalIdNoun === undefined ? {} : { externalIdNoun }),
				...(creatorNoun === undefined ? {} : { creatorNoun }),
				supportedFeatures,
			},
		},
	});
	if (!read.ok) throw new Error(`清单没读成: ${JSON.stringify(read)}`);
	return read.manifest;
}

function recordingLogger() {
	const lines: string[] = [];
	const logger: Logger = {
		debug: (m) => lines.push(`debug ${m}`),
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
	};
	return { logger, lines };
}

/** 核心那一份上下文的替身:只记三种上报收到了什么。其余成员用不到,不装。 */
function coreContext() {
	const posts: Array<[string, PostReport]> = [];
	const lives: Array<[string, LiveSignalReport]> = [];
	const profiles: Array<[string, CreatorProfileReport]> = [];
	const signal = new AbortController().signal;
	const ctx = {
		logger: recordingLogger().logger,
		signal,
		onDispose() {},
		state: {},
		secrets: {},
		redact() {},
		reportProblem() {},
		resolveProblem() {},
		settings: () => ({ get: () => ({ ok: true }), onChange: () => ({ dispose() {} }) }),
		http: {},
		fetchImage: async () => ({ ok: false }),
		storeImage: async () => ({ ok: false }),
		subscriptions: () => [],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		reportPost: (externalId: string, report: PostReport) => posts.push([externalId, report]),
		reportLive: (externalId: string, report: LiveSignalReport) => lives.push([externalId, report]),
		reportProfile: (externalId: string, report: CreatorProfileReport) =>
			profiles.push([externalId, report]),
		reportLiveInteraction() {},
		registerLinkResolver: () => ({ dispose() {} }),
		registerAiToolProvider: () => ({ dispose() {} }),
	} as unknown as SourceContext;
	return { ctx, posts, lives, profiles };
}

interface Made {
	source: ReturnType<typeof createExtensionSource>;
	core: ReturnType<typeof coreContext>;
	discrepancies: ExtensionSourceDiscrepancy[];
	lines: string[];
	/** `start` 时递给拓展的那面 ctx。 */
	ext(): ExtensionSourceContext;
	/** 等这个来源自己那条串行队里已收下的上报处理完(翻作品要读图库,是异步的)。 */
	idle(): Promise<void>;
}

/** 手搓的最小 PNG 头(魔数 + IHDR 的宽高),`readImageSize` 只读头。 */
function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

/** 手搓的最小 GIF 头(GIF89a + 逻辑屏幕宽高,小端)。 */
function gifBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(13);
	bytes.set([..."GIF89a"].map((ch) => ch.charCodeAt(0)));
	new DataView(bytes.buffer).setUint16(6, width, true);
	new DataView(bytes.buffer).setUint16(8, height, true);
	return bytes;
}

type Stored = { bytes: Buffer; mime: string } | undefined;

/** 造一份适配后的来源并 `start` 过。`def` 里没给的必备成员补空实现。 */
async function make(
	def: Partial<SourceDef> & Record<string, unknown> = {},
	opts: {
		supportedFeatures?: string[];
		images?: (ref: string) => Promise<Stored> | Stored;
		start?: boolean;
		externalIdNoun?: string;
		creatorNoun?: string;
	} = {},
): Promise<Made> {
	const { logger, lines } = recordingLogger();
	const discrepancies: ExtensionSourceDiscrepancy[] = [];
	let handed: ExtensionSourceContext | undefined;
	const full = {
		start(ctx: ExtensionSourceContext) {
			handed = ctx;
		},
		stop() {},
		searchCreators: async () => ({ ok: true as const, candidates: [] }),
		...def,
	} as unknown as SourceDef;
	const source = createExtensionSource({
		id: "douyin",
		manifest: manifestOf(opts.supportedFeatures, opts.externalIdNoun, opts.creatorNoun),
		def: full,
		logger,
		images: { read: async (ref) => opts.images?.(ref) },
		recordDiscrepancy: (one) => discrepancies.push(one),
		fallbackCreatorName: (externalId) => `资料名-${externalId}`,
		now: () => ARRIVED,
	});
	const core = coreContext();
	if (opts.start !== false) await source.start(core.ctx);
	return {
		source,
		core,
		discrepancies,
		lines,
		ext() {
			if (!handed) throw new Error("拓展的 start 没被叫到");
			return handed;
		},
		idle: () => new Promise((resolve) => setTimeout(resolve, 0)),
	};
}

describe("createExtensionSource:成员与描述符", () => {
	it("描述符取自清单(平台名、作品叫法、外部 id 格式),不取拓展自己交的", async () => {
		const made = await make({ descriptor: { label: "冒充" } });
		expect(made.source.descriptor).toEqual({
			label: "抖音",
			postNoun: "作品",
			externalIdRegex: "[a-z0-9-]+",
		});
	});

	it("描述符带上外部 id 叫法,身份标签用「叫法 + id」;没声明时照旧用平台名", async () => {
		const named = await make({}, { start: false, externalIdNoun: "账号" });
		const namedRegistry = createSourceRegistry();
		await namedRegistry.register("douyin", named.source, named.core.ctx);
		expect(named.source.descriptor.externalIdNoun).toBe("账号");
		expect(
			subscriptionIdentityLabelOf(
				{ sourceKey: "douyin", externalId: "u1" },
				{ sources: namedRegistry },
			),
		).toBe("账号 u1");

		const unnamed = await make({}, { start: false });
		const unnamedRegistry = createSourceRegistry();
		await unnamedRegistry.register("douyin", unnamed.source, unnamed.core.ctx);
		expect(
			subscriptionIdentityLabelOf(
				{ sourceKey: "douyin", externalId: "u1" },
				{ sources: unnamedRegistry },
			),
		).toBe("抖音 · u1");
	});

	it("描述符带上创作者叫法", async () => {
		const made = await make({}, { start: false, creatorNoun: "博主" });
		expect(made.source.descriptor.creatorNoun).toBe("博主");
	});

	it("成员按表取,方法 bind 回拓展交的实例(class 写的拓展方法在原型上、吃 this)", async () => {
		class Impl {
			calls: string[] = [];
			start(_ctx: ExtensionSourceContext) {
				this.calls.push("start");
			}
			stop() {
				this.calls.push("stop");
			}
			async searchCreators(query: string) {
				this.calls.push(`search:${query}`);
				return { ok: true as const, candidates: [] };
			}
		}
		const impl = new Impl();
		const { logger } = recordingLogger();
		const source = createExtensionSource({
			id: "douyin",
			manifest: manifestOf(),
			def: impl as unknown as SourceDef,
			logger,
			images: { read: async () => undefined },
			recordDiscrepancy() {},
			fallbackCreatorName: () => "x",
		});
		await source.start(coreContext().ctx);
		await source.searchCreators("猫", new AbortController().signal);
		await source.stop();
		expect(impl.calls).toEqual(["start", "search:猫", "stop"]);
	});

	it("不开的成员带了也不认:auth、liveInteractions、descriptor;health 按表收下", async () => {
		const made = await make({
			auth: { state: () => ({ status: "logged-in" }) },
			liveInteractions: { fetchViewerAvatar: async () => ({ ok: false }) },
			descriptor: { label: "冒充" },
			health: () => ({ summary: "好着呢" }),
		});
		expect(made.source.auth).toBeUndefined();
		expect(made.source.liveInteractions).toBeUndefined();
		expect(made.source.health?.()).toEqual({ summary: "好着呢" });
		expect(made.source.descriptor.label).toBe("抖音");
	});

	it("拓展拿到的 ctx 里没有核心独有的三个口:链接解析、AI 工具、直播互动(运行时也拿不到)", async () => {
		const made = await make();
		for (const name of [
			"registerLinkResolver",
			"registerAiToolProvider",
			"reportLiveInteraction",
		]) {
			expect(name in made.ext(), name).toBe(false);
		}
		for (const name of ["reportPost", "reportLive", "reportProfile", "subscriptions", "signal"]) {
			expect(name in made.ext(), name).toBe(true);
		}
	});

	it("拓展的 start 抛了:原样抛给登记表", async () => {
		const { logger } = recordingLogger();
		const source = createExtensionSource({
			id: "douyin",
			manifest: manifestOf(),
			def: {
				start() {
					throw new Error("连不上平台");
				},
				stop() {},
				searchCreators: async () => ({ ok: true, candidates: [] }),
			},
			logger,
			images: { read: async () => undefined },
			recordDiscrepancy() {},
			fallbackCreatorName: () => "x",
		});
		await expect(source.start(coreContext().ctx)).rejects.toThrow("连不上平台");
	});
});

describe("createExtensionSource:健康状态按外来数据收", () => {
	async function healthRows(health: unknown) {
		const made = await make({ health } as Partial<SourceDef>, { start: false });
		const registry = createSourceRegistry();
		await registry.register("douyin", made.source, made.core.ctx);
		const error = vi.fn();
		const read = () => readSourceHealth(registry.list(), { error });
		return { read, error, lines: made.lines };
	}

	it("非对象、summary 类型不对、空白、Promise 与 thenable:都写「状态读不到」", async () => {
		const badBodies = [
			() => ({}),
			() => null,
			() => [],
			() => ({ summary: 1 }),
			() => ({ summary: " \n\t " }),
			() => Promise.reject(new Error("late failure")),
			() => ({
				// biome-ignore lint/suspicious/noThenProperty: 这里故意交 thenable,验适配器的拒绝会被接住
				then(_resolve: unknown, reject: (err: Error) => void) {
					reject(new Error("late thenable failure"));
				},
			}),
		];
		for (const health of badBodies) {
			const made = await healthRows(health);
			expect(made.read()).toEqual([{ label: "抖音", summary: "状态读不到" }]);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("换行与连续空白收成一个空格,首尾空白去掉", async () => {
		const made = await healthRows(() => ({ summary: "  上次\n抓取 \t 2 分钟前  " }));
		expect(made.read()).toEqual([{ label: "抖音", summary: "上次 抓取 2 分钟前" }]);
	});

	it("超过 120 字截断,截断处不劈开代理对", async () => {
		const many = await healthRows(() => ({ summary: "a".repeat(300) }));
		expect(many.read()[0]?.summary).toBe("a".repeat(120));

		const paired = await healthRows(() => ({ summary: `${"a".repeat(119)}😀z` }));
		expect(paired.read()[0]?.summary).toBe("a".repeat(119));
	});

	it("正常的一行原样交出去", async () => {
		const made = await healthRows(() => ({ summary: "抓取正常" }));
		expect(made.read()).toEqual([{ label: "抖音", summary: "抓取正常" }]);
	});

	it("同一个坏法连读三次只 warn 一次;原因换了再记", async () => {
		const same = await healthRows(() => ({}));
		same.read();
		same.read();
		same.read();
		expect(same.lines.filter((line) => line.startsWith("warn "))).toHaveLength(1);

		let summary: unknown = 1;
		const changing = await healthRows(() => ({ summary }));
		changing.read();
		changing.read();
		summary = "";
		changing.read();
		expect(changing.lines.filter((line) => line.startsWith("warn "))).toHaveLength(2);
	});
});

describe("createExtensionSource:作品上报", () => {
	it("带时区的 ISO 统一成 UTC Z,图库引用换成 PostImage,话题与视频与互动数照搬,缺名补链", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: {
				publishedAt: T_OFFSET,
				text: "今天去海边",
				images: [REF, REF_B],
				topic: "旅行",
				video: { cover: REF, title: "海边", durationSec: 61, views: 9 },
				stats: { likes: 3, comments: 2, shares: 1 },
			},
		});
		await made.idle();
		expect(made.discrepancies).toEqual([]);
		expect(made.core.posts).toEqual([
			[
				"u1",
				{
					postId: "p1",
					url: "https://douyin.invalid/p1",
					post: {
						// 事件没带名字 → 资料名 / 身份标签那一条链(替身里是「资料名-<id>」)。
						creator: { name: "资料名-u1" },
						publishedAt: T_ISO,
						text: "今天去海边",
						images: [{ ref: REF }, { ref: REF_B }],
						topic: "旅行",
						video: {
							cover: { ref: REF },
							title: "海边",
							description: "",
							durationSec: 61,
							views: 9,
						},
						stats: { likes: 3, comments: 2, shares: 1 },
					},
				},
			],
		]);
	});

	it("事件带了作者名与头像:用它的,不补", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: T_ISO, text: "x", creator: { name: "小明", avatar: REF } },
		});
		await made.idle();
		expect(made.core.posts[0]?.[1].post.creator).toEqual({ name: "小明", avatar: REF });
	});

	it("事件只带了头像没带名字:名字补链,头像留着", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: T_ISO, text: "x", creator: { avatar: REF } },
		});
		await made.idle();
		expect(made.core.posts[0]?.[1].post.creator).toEqual({ name: "资料名-u1", avatar: REF });
	});

	it("正文里的 CRLF 换成 LF,只有空白的正文收成空串;富文本对不上正文就丢掉", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: {
				publishedAt: T_ISO,
				text: "甲\r\n乙",
				richText: [{ kind: "text", text: "对不上" }],
			},
		});
		await made.idle();
		made.ext().reportPost("u1", {
			postId: "p2",
			url: "https://douyin.invalid/p2",
			post: { publishedAt: T_ISO, text: "  \n " },
		});
		await made.idle();
		const [first, second] = made.core.posts.map(([, report]) => report.post);
		expect(first?.text).toBe("甲\n乙");
		expect(first?.richText).toBeUndefined();
		expect(second?.text).toBe("");
		expect(made.discrepancies).toContainEqual(
			expect.objectContaining({ kind: "post", outcome: "dropped" }),
		);
		expect(made.discrepancies.map((one) => one.reasons.join("")).join("")).toContain(
			"post.richText",
		);
	});

	it("片段带 CRLF、正文也带时,两边一起换行,富文本留下", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: {
				publishedAt: T_ISO,
				text: "第一行\r\n#旅行#",
				richText: [
					{ kind: "text", text: "第一行\r\n" },
					{ kind: "topic", text: "#旅行#", name: "旅行" },
				],
			},
		});
		await made.idle();
		const post = made.core.posts[0]?.[1].post;
		expect(post?.text).toBe("第一行\n#旅行#");
		expect(post?.richText).toEqual([
			{ kind: "text", text: "第一行\n" },
			{ kind: "topic", text: "#旅行#", name: "旅行" },
		]);
	});

	it("CRLF 劈在两段之间:换完再拼等于拼完再换,富文本留下", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: {
				publishedAt: T_ISO,
				text: "甲\r\n乙",
				richText: [
					{ kind: "text", text: "甲\r" },
					{ kind: "text", text: "\n乙" },
				],
			},
		});
		await made.idle();
		const post = made.core.posts[0]?.[1].post;
		expect(post?.text).toBe("甲\n乙");
		expect(post?.richText?.map((segment) => segment.text).join("")).toBe("甲\n乙");
	});

	it("对得上正文的富文本原样带过去", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: {
				publishedAt: T_ISO,
				text: "去#旅行#吧",
				richText: [
					{ kind: "text", text: "去" },
					{ kind: "topic", text: "#旅行#", name: "旅行" },
					{ kind: "text", text: "吧" },
				],
			},
		});
		await made.idle();
		expect(made.core.posts[0]?.[1].post.richText).toHaveLength(3);
	});

	it("清单没声明 post:整条拒,进出入表,核心那头什么都没收到", async () => {
		const made = await make({}, { supportedFeatures: ["liveStart", "liveEnd"] });
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: T_ISO, text: "x" },
		});
		await made.idle();
		expect(made.core.posts).toEqual([]);
		expect(made.discrepancies).toHaveLength(1);
		expect(made.discrepancies[0]).toMatchObject({
			kind: "post",
			externalId: "u1",
			outcome: "rejected",
		});
		expect(made.discrepancies[0]?.reasons.join("")).toContain("post");
		expect(made.lines.some((line) => line.startsWith("debug"))).toBe(false);
	});

	it("多交一格:整条拒,原因点名那一格", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: T_ISO, text: "x", title: "不开放的格" },
		} as unknown as ExtensionPostReport);
		await made.idle();
		expect(made.core.posts).toEqual([]);
		expect(made.discrepancies).toHaveLength(1);
		expect(made.discrepancies[0]?.outcome).toBe("rejected");
		expect(made.discrepancies[0]?.reasons.join("")).toContain("post.title");
	});

	it("认识的选填格坏了:只丢那一格,其余照收,出入表记一条 dropped", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: T_ISO, text: "x", stats: { likes: -1, comments: 5 } },
		});
		await made.idle();
		expect(made.core.posts[0]?.[1].post.stats).toEqual({ comments: 5 });
		expect(made.discrepancies).toHaveLength(1);
		expect(made.discrepancies[0]).toMatchObject({ kind: "post", outcome: "dropped" });
		expect(made.discrepancies[0]?.reasons.join("")).toContain("post.stats.likes");
	});

	it("不带时区的时刻:整条拒", async () => {
		const made = await make();
		made.ext().reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: "2026-10-25T12:00:00", text: "x" },
		});
		await made.idle();
		expect(made.core.posts).toEqual([]);
		expect(made.discrepancies[0]).toMatchObject({ outcome: "rejected" });
		expect(made.discrepancies[0]?.reasons.join("")).toContain("post.publishedAt");
	});

	it("外部 id 不是 1–256 字的字符串:整条拒,出入表里的外部 id 截成能看的一段", async () => {
		const made = await make();
		const report: ExtensionPostReport = {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: T_ISO, text: "x" },
		};
		made.ext().reportPost("", report);
		await made.idle();
		made.ext().reportPost(42 as unknown as string, report);
		await made.idle();
		made.ext().reportPost("x".repeat(300), report);
		await made.idle();
		expect(made.core.posts).toEqual([]);
		expect(made.discrepancies.map((one) => one.externalId)).toEqual([
			"",
			"(number)",
			`${"x".repeat(64)}…`,
		]);
		for (const one of made.discrepancies) expect(one.outcome).toBe("rejected");
	});
});

describe("createExtensionSource:作品图的宽高与动图标记", () => {
	const post = (images: string[], video?: { cover: string }) => ({
		postId: "p1",
		url: "https://douyin.invalid/p1",
		post: { publishedAt: T_ISO, text: "x", images, ...(video ? { video } : {}) },
	});
	const stored = (bytes: Uint8Array): Stored => ({ bytes: Buffer.from(bytes), mime: "image/png" });

	it("竖长 png:PostImage 有宽高、isAnimated 为 false;视频封面同样补", async () => {
		const made = await make(
			{},
			{ images: (ref) => (ref === REF ? stored(pngBytes(100, 400)) : undefined) },
		);
		made.ext().reportPost("u1", post([REF], { cover: REF }));
		await made.idle();
		const reported = made.core.posts[0]?.[1].post;
		expect(reported?.images).toEqual([{ ref: REF, width: 100, height: 400, isAnimated: false }]);
		expect(reported?.video?.cover).toEqual({
			ref: REF,
			width: 100,
			height: 400,
			isAnimated: false,
		});
	});

	it("gif:isAnimated 为 true,宽高读 GIF 头", async () => {
		const made = await make({}, { images: () => stored(gifBytes(320, 240)) });
		made.ext().reportPost("u1", post([REF]));
		await made.idle();
		expect(made.core.posts[0]?.[1].post.images).toEqual([
			{ ref: REF, width: 320, height: 240, isAnimated: true },
		]);
	});

	it("引用读不到(图已被清扫)或读盘抛了:这张只放 ref、记 debug,整条照收", async () => {
		const gone = await make({}, { images: () => undefined });
		gone.ext().reportPost("u1", post([REF]));
		await gone.idle();
		expect(gone.core.posts[0]?.[1].post.images).toEqual([{ ref: REF }]);
		expect(gone.lines.some((line) => line.startsWith("debug"))).toBe(true);
		expect(gone.discrepancies).toEqual([]);

		const broken = await make(
			{},
			{
				images: () => {
					throw new Error("读盘出错");
				},
			},
		);
		broken.ext().reportPost("u1", post([REF]));
		await broken.idle();
		expect(broken.core.posts[0]?.[1].post.images).toEqual([{ ref: REF }]);
	});

	it("直播封面照第 2 版:只放引用,不读图库", async () => {
		let reads = 0;
		const made = await make(
			{},
			{
				images: () => {
					reads += 1;
					return undefined;
				},
			},
		);
		made.ext().reportLive("u1", { kind: "start", details: { cover: REF } });
		await made.idle();
		expect(made.core.lives[0]?.[1]).toMatchObject({ details: { cover: { ref: REF } } });
		expect(reads).toBe(0);
	});

	it("同一拓展的上报按到达顺序交给核心:前一条读图慢,后一条也排在它后面", async () => {
		let release!: () => void;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const made = await make(
			{},
			{
				images: async (ref) => {
					if (ref === REF) await slow;
					return undefined;
				},
			},
		);
		made.ext().reportPost("u1", { ...post([REF]), postId: "first" });
		made.ext().reportPost("u1", { ...post([REF_B]), postId: "second" });
		await made.idle();
		expect(made.core.posts).toEqual([]);
		release();
		await made.idle();
		await made.idle();
		expect(made.core.posts.map(([, report]) => report.postId)).toEqual(["first", "second"]);
	});

	it("置停时队里还没交出去的上报不交给核心、记 debug;置停之前已经交出去的照常到了核心;stop 之后新来的不收", async () => {
		let release!: () => void;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stops: string[] = [];
		const made = await make(
			{ stop: () => void stops.push("stop") },
			{
				images: async (ref) => {
					if (ref === REF_B) await slow;
					return undefined;
				},
			},
		);
		made.ext().reportPost("u1", { ...post([REF]), postId: "sent" });
		await made.idle();
		made.ext().reportPost("u1", { ...post([REF_B]), postId: "queued" });
		// 让它开始读图(卡在慢读上),再置停。
		await made.idle();
		await made.source.stop();
		made.ext().reportPost("u1", { ...post([REF]), postId: "late" });
		release();
		await made.idle();
		await made.idle();
		expect(stops).toEqual(["stop"]);
		expect(made.core.posts.map(([, report]) => report.postId)).toEqual(["sent"]);
		expect(made.lines.some((line) => line.startsWith("debug") && line.includes("丢弃"))).toBe(true);
		expect(made.lines.some((line) => line.startsWith("error"))).toBe(false);
	});
});

describe("createExtensionSource:直播上报", () => {
	it("开播:ISO 统一成 UTC Z,封面与作者头像换成引用,现在在线 / 累计观看照搬", async () => {
		const made = await make();
		made.ext().reportLive("u1", {
			kind: "start",
			startedAt: T_ISO,
			details: {
				title: "开播了",
				cover: REF,
				category: "聊天",
				url: "https://live.invalid/1",
				currentViewers: 7,
				totalViewers: 70,
				creator: { avatar: REF_B },
			},
		});
		await made.idle();
		expect(made.core.lives).toEqual([
			[
				"u1",
				{
					kind: "start",
					startedAt: T_ISO,
					details: {
						title: "开播了",
						cover: { ref: REF },
						category: "聊天",
						url: "https://live.invalid/1",
						currentViewers: 7,
						totalViewers: 70,
						creator: { name: "资料名-u1", avatar: REF_B },
					},
				},
			],
		]);
	});

	it("直播状态:isLive 与开播时刻照搬;没交 details 内容也收(空对象)", async () => {
		const made = await make();
		made.ext().reportLive("u1", { kind: "status", isLive: true, startedAt: T_ISO, details: {} });
		await made.idle();
		expect(made.core.lives).toEqual([
			["u1", { kind: "status", isLive: true, startedAt: T_ISO, details: {} }],
		]);
	});

	it("下播交了 endedAt:ISO 统一成 UTC Z", async () => {
		const made = await make();
		made.ext().reportLive("u1", {
			kind: "end",
			endedAt: T_OFFSET,
			startedAt: "2026-09-23T11:00:00.000Z",
		});
		await made.idle();
		expect(made.core.lives[0]?.[1]).toEqual({
			kind: "end",
			endedAt: T_ISO,
			startedAt: "2026-09-23T11:00:00.000Z",
		});
	});

	it("下播没交 endedAt:取上报到达的那一刻", async () => {
		const made = await make();
		made.ext().reportLive("u1", { kind: "end" });
		await made.idle();
		expect(made.core.lives[0]?.[1]).toEqual({ kind: "end", endedAt: ARRIVED_ISO });
	});

	it("清单只声明了开播:下播整条拒;直播状态要开播或下播其一,收", async () => {
		const made = await make({}, { supportedFeatures: ["post", "liveStart"] });
		made.ext().reportLive("u1", { kind: "end" });
		await made.idle();
		made.ext().reportLive("u1", { kind: "status", isLive: false, details: {} });
		await made.idle();
		expect(made.core.lives.map(([, report]) => report.kind)).toEqual(["status"]);
		expect(made.discrepancies).toHaveLength(1);
		expect(made.discrepancies[0]).toMatchObject({ kind: "live", outcome: "rejected" });
		expect(made.discrepancies[0]?.reasons.join("")).toContain("liveEnd");
	});

	it("清单什么直播事件都没声明:直播状态也拒,原因点名 liveStart 与 liveEnd", async () => {
		const made = await make({}, { supportedFeatures: ["post"] });
		made.ext().reportLive("u1", { kind: "status", isLive: true, details: {} });
		await made.idle();
		expect(made.core.lives).toEqual([]);
		const reason = made.discrepancies[0]?.reasons.join("") ?? "";
		expect(reason).toContain("liveStart");
		expect(reason).toContain("liveEnd");
	});

	it("种类认不出:整条拒", async () => {
		const made = await make();
		made.ext().reportLive("u1", { kind: "pause" } as unknown as ExtensionLiveSignalReport);
		await made.idle();
		expect(made.core.lives).toEqual([]);
		expect(made.discrepancies[0]).toMatchObject({ kind: "live", outcome: "rejected" });
	});
});

describe("createExtensionSource:资料上报", () => {
	it("资料总收(不看清单声明),原样交核心", async () => {
		const made = await make({}, { supportedFeatures: ["post"] });
		made.ext().reportProfile("u1", { name: "小明", avatar: REF, followers: 12, bio: "简介" });
		await made.idle();
		expect(made.core.profiles).toEqual([
			["u1", { name: "小明", avatar: REF, followers: 12, bio: "简介" }],
		]);
	});

	it("多交一格(旧契约的 fans):整条拒,进出入表", async () => {
		const made = await make();
		made.ext().reportProfile("u1", { name: "小明", fans: 12 } as unknown as CreatorProfileReport);
		await made.idle();
		expect(made.core.profiles).toEqual([]);
		expect(made.discrepancies[0]).toMatchObject({ kind: "profile", outcome: "rejected" });
		expect(made.discrepancies[0]?.reasons.join("")).toContain("fans");
	});

	it("头像引用不是图库引用:只丢头像,名字照收", async () => {
		const made = await make();
		made.ext().reportProfile("u1", { name: "小明", avatar: "https://x.invalid/a.png" });
		await made.idle();
		expect(made.core.profiles).toEqual([["u1", { name: "小明" }]]);
		expect(made.discrepancies[0]).toMatchObject({ kind: "profile", outcome: "dropped" });
	});
});

describe("createExtensionSource:stop 之后", () => {
	it("stop 叫到拓展的 stop(同步或 Promise 都接);之后的上报不往核心交,记一行 warn", async () => {
		const stops: string[] = [];
		const made = await make({
			stop: async () => {
				stops.push("stop");
			},
		});
		await made.source.stop();
		made.ext().reportProfile("u1", { name: "小明" });
		await made.idle();
		expect(stops).toEqual(["stop"]);
		expect(made.core.profiles).toEqual([]);
		expect(made.lines.some((line) => line.startsWith("warn"))).toBe(true);
	});
});

describe("createExtensionSource:搜人", () => {
	it("候选合规矩:原样交回", async () => {
		const made = await make({
			searchCreators: async () => ({
				ok: true,
				candidates: [{ externalId: "u1", name: "小明", followers: 3, avatar: REF }],
			}),
		});
		expect(await made.source.searchCreators("明", new AbortController().signal)).toEqual({
			ok: true,
			candidates: [{ externalId: "u1", name: "小明", followers: 3, avatar: REF }],
		});
	});

	it("候选坏了(旧契约的 fans / 外部 id 重复):回 invalid,message 点名哪一格", async () => {
		const made = await make({
			searchCreators: async () => ({
				ok: true,
				candidates: [{ externalId: "u1", name: "小明", fans: 3 }],
			}),
		});
		const result = await made.source.searchCreators("明", new AbortController().signal);
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(result.ok ? "" : result.message).toContain("fans");

		const dup = await make({
			searchCreators: async () => ({
				ok: true,
				candidates: [
					{ externalId: "u1", name: "甲" },
					{ externalId: "u1", name: "乙" },
				],
			}),
		});
		const dupResult = await dup.source.searchCreators("明", new AbortController().signal);
		expect(dupResult).toMatchObject({ ok: false, code: "invalid" });
		expect(dupResult.ok ? "" : dupResult.message).toContain("externalId");
	});

	it("交回的根本不是结果形状:invalid", async () => {
		const made = await make({
			searchCreators: (async () => "没有结果") as unknown as SourceDef["searchCreators"],
		});
		expect(await made.source.searchCreators("明", new AbortController().signal)).toMatchObject({
			ok: false,
			code: "invalid",
		});
	});

	it("拓展回的失败(风控、没登录……):码与原话原样交回", async () => {
		const made = await make({
			searchCreators: async () => ({ ok: false, code: "rate_limited", message: "被风控了" }),
		});
		expect(await made.source.searchCreators("明", new AbortController().signal)).toEqual({
			ok: false,
			code: "rate_limited",
			message: "被风控了",
		});
	});

	it("失败的码不是标准码:invalid", async () => {
		const made = await make({
			searchCreators: (async () => ({
				ok: false,
				code: "boom",
				message: "x",
			})) as unknown as SourceDef["searchCreators"],
		});
		expect(await made.source.searchCreators("明", new AbortController().signal)).toMatchObject({
			ok: false,
			code: "invalid",
		});
	});

	it("拓展抛了:回失败,原话进 message", async () => {
		const made = await make({
			searchCreators: async () => {
				throw new Error("cookie 过期了");
			},
		});
		const result = await made.source.searchCreators("明", new AbortController().signal);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		expect(result.ok ? "" : result.message).toContain("cookie 过期了");
	});
});

describe("createExtensionSource:取资料", () => {
	it("拓展没实现 fetchProfile:宿主补一个回 unsupported 的", async () => {
		const made = await make();
		const result = await made.source.fetchProfile(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: false, code: "unsupported" });
	});

	it("实现了就调,结果合规矩原样交回(铺平的 Result 形状)", async () => {
		const asked: string[] = [];
		const made = await make({
			fetchProfile: async (identity: { externalId: string }) => {
				asked.push(identity.externalId);
				return { ok: true, name: "小明", followers: 3 };
			},
		});
		const result = await made.source.fetchProfile(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(asked).toEqual(["u1"]);
		expect(result).toEqual({ ok: true, name: "小明", followers: 3 });
	});

	it("结果坏了(多一格):invalid,点名哪一格,记进出入表", async () => {
		const made = await make({
			fetchProfile: async () => ({ ok: true, name: "小明", fans: 3 }),
		});
		const result = await made.source.fetchProfile(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(result.ok ? "" : result.message).toContain("fans");
		expect(made.discrepancies).toContainEqual(
			expect.objectContaining({ kind: "profile", externalId: "u1", outcome: "rejected" }),
		);
	});

	it("选填格坏了只丢那一格,照收其余,记进出入表", async () => {
		const made = await make({
			fetchProfile: async () => ({ ok: true, name: "小明", followers: -1 }),
		});
		const result = await made.source.fetchProfile(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toEqual({ ok: true, name: "小明" });
		expect(made.discrepancies).toContainEqual(
			expect.objectContaining({ kind: "profile", externalId: "u1", outcome: "dropped" }),
		);
		expect(made.discrepancies[0]?.reasons.join("")).toContain("followers");
	});

	it("拓展抛了:unavailable,原话进 message", async () => {
		const made = await make({
			fetchProfile: async () => {
				throw new Error("平台挂了");
			},
		});
		const result = await made.source.fetchProfile(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		expect(result.ok ? "" : result.message).toContain("平台挂了");
	});
});

describe("createExtensionSource:拉取式直播状态", () => {
	it("拓展没实现 fetchLiveStatus:这一格不放(核心据此知道它没有拉取式)", async () => {
		const made = await make();
		expect(made.source.fetchLiveStatus).toBeUndefined();
	});

	it("在播:ISO 统一成 UTC Z,封面换引用", async () => {
		const made = await make({
			fetchLiveStatus: async () => ({
				ok: true,
				kind: "live",
				startedAt: T_ISO,
				details: { title: "在播", cover: REF },
			}),
		});
		const result = await made.source.fetchLiveStatus?.(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toEqual({
			ok: true,
			kind: "live",
			startedAt: T_ISO,
			details: { title: "在播", cover: { ref: REF } },
		});
	});

	it("没在播与拓展自己回的失败:原样", async () => {
		const offline = await make({ fetchLiveStatus: async () => ({ ok: true, kind: "offline" }) });
		const signal = new AbortController().signal;
		const identity = { sourceKey: "douyin", externalId: "u1" };
		expect(await offline.source.fetchLiveStatus?.(identity, signal)).toEqual({
			ok: true,
			kind: "offline",
		});
		const failed = await make({
			fetchLiveStatus: async () => ({ ok: false, code: "timeout", message: "超时" }),
		});
		expect(await failed.source.fetchLiveStatus?.(identity, signal)).toEqual({
			ok: false,
			code: "timeout",
			message: "超时",
		});
	});

	it("选填格坏了只丢那一格,照收其余,记进出入表", async () => {
		const made = await make({
			fetchLiveStatus: async () => ({
				ok: true,
				kind: "live",
				startedAt: T_ISO,
				details: { title: "在播", currentViewers: -1 },
			}),
		});
		const result = await made.source.fetchLiveStatus?.(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toEqual({
			ok: true,
			kind: "live",
			startedAt: T_ISO,
			details: { title: "在播" },
		});
		expect(made.discrepancies).toContainEqual(
			expect.objectContaining({ kind: "live", externalId: "u1", outcome: "dropped" }),
		);
		expect(made.discrepancies[0]?.reasons.join("")).toContain("details.currentViewers");
	});

	it("结果坏了(必填的失败话是空的):回失败 invalid,不抛,记进出入表", async () => {
		const made = await make({
			fetchLiveStatus: async () => ({ ok: false, code: "timeout", message: "" }),
		});
		const result = await made.source.fetchLiveStatus?.(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(result?.ok === false ? result.message : "").toContain("message");
		expect(made.discrepancies).toContainEqual(
			expect.objectContaining({ kind: "live", externalId: "u1", outcome: "rejected" }),
		);
	});

	it("拓展抛了:回失败 unavailable", async () => {
		const made = await make({
			fetchLiveStatus: async () => {
				throw new Error("查不了");
			},
		});
		const result = await made.source.fetchLiveStatus?.(
			{ sourceKey: "douyin", externalId: "u1" },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
	});
});
