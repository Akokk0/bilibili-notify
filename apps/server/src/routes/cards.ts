import { packageText } from "@bilibili-notify/internal/texts";
import { logText } from "../i18n/index.js";
import { logUrl } from "../logs/url.js";
/**
 * `POST /api/cards/preview` —— 卡片页右侧的预览:用 puppeteer-core 画一张卡,回 data URL。
 *
 * 画什么,看请求的 `content`:
 *
 *   作品 / 直播 + `subscriptionId` → 那条订阅的来源实现了 `Source.fetchPreview` 就问它要一份真数据
 *                                    (作品取最近的第 `nth` 条,直播取直播间此刻的样子),
 *                                    经出卡器的同一个入口(`ImageRenderer`)画,与真推送一个样;
 *                                    没实现就用示例。来源回了失败也用示例,回应的 `sampleReason` 带原话;
 *   作品 / 直播,没挑订阅            → 示例数据(调样式不必登录任何平台);
 *   醒目留言 / 上舰                   → 示例消息;挑了订阅就把收的人写成那条订阅的名字,付款人 / 新会员取
 *                                    那个来源登录着的账号名,没有就是示例名。
 *
 * 路由不认识任何平台:真数据只经来源登记表问来源(4-14,ADR-0021 决策 59)。
 *
 * not_configured path (409) — when the operator hasn't set BN_CHROME_PATH (or
 * chromePath in yaml) we don't try to launch puppeteer. The route reports the
 * missing config so the Cards page can render an actionable hint; the engine
 * not being up yet is a different failure (`unavailable`, 503) and the page
 * tells the two apart by `code`, not by status.
 *
 * Failures follow docs/agents/conventions/failure-results.md: anything the
 * request itself gets wrong or can't proceed with is a non-2xx error body via
 * `respondFailure`; "tried and it didn't work" (a render that threw, a
 * delivery that wasn't accepted) answers 200 with a `Result`.
 */

import {
	type CardSkinShotResponse,
	displayNameOf,
	type PreviewResponse,
	type TestPushResponse,
} from "@bilibili-notify/contract";
import {
	type CardSkinChoice,
	h,
	ImageRenderer,
	type LiveCardView,
	type PostCardView,
	renderCardWithSkin,
	resolveKnobAssets,
	shrinkImageForCssVar,
} from "@bilibili-notify/image";
import {
	CARD_KIND_NAMES,
	CARD_SKIN_LIMITS,
	type CardKind,
	CardKindSchema,
	CardSkinIdSchema,
	type CardSkinKnobOverrides,
	CardSkinKnobOverridesSchema,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	effectiveCardSkinKnobs,
	fail,
	type ImageRef,
	issuesFromZod,
	type NotificationPayload,
	ok,
	type Post,
	type PreviewOptions,
	type PreviewReport,
	type Result,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { prefetchCardSkinAssets, readCardSkinAssetDataUrl } from "../card-skins/asset-url.js";
import { membershipTierUnavailable, renderSkinPreviewHtml } from "../card-skins/preview-html.js";
import type { CardSkinStore } from "../card-skins/store.js";
import type { ChromeSource } from "../config/persist.js";
import { t } from "../i18n/index.js";
import { imageRefDataUrl } from "../images/image-data-url.js";
import { liveCardInputFromDetails } from "../live/live-card-input.js";
import { firstExistingCardBg, readCardBgDataUrl } from "../runtime/card-assets.js";
import {
	createPuppeteerAdapter,
	type PuppeteerAdapter,
	resolveChromePath,
} from "../runtime/puppeteer.js";
import { createMembershipTierReader } from "../subscriptions/membership-tiers.js";
import { subscriptionIdentityLabelOf } from "../subscriptions/platform-label.js";
import { errorMessageOf } from "../util/error-message.js";
import { failureOfChecks } from "../util/failure-text.js";
import { pipelineNotReadyMessage, respondFailure } from "./respond-failure.js";
import { testResultOfDelivery } from "./test-result.js";
import type { RouteDeps } from "./types.js";

export interface CardsRouteOptions {
	deps: RouteDeps;
	puppeteer: PuppeteerAdapter | null;
	/**
	 * 启动时实际生效的浏览器来源(bootstrap 里 endpoint 赢过 path 的那一个),
	 * 供 GET /renderer 展示与同源幂等判断;未启用时缺省。
	 */
	initialChromeSource?: ChromeSource;
	/**
	 * 探测本机 Chrome 路径(默认 resolveChromePath 扫常见安装位置);注入便于测试。
	 * 供 GET /chrome 的「自动探测」按钮。
	 */
	detectChrome?: () => string | null;
	/**
	 * 构造 puppeteer adapter(默认 createPuppeteerAdapter,懒启动);注入便于测试。
	 * 供 POST /renderer 运行时热启用,source 为本地路径或远程端点。
	 */
	createPuppeteer?: (source: ChromeSource) => PuppeteerAdapter;
	/**
	 * 热启用路径新建 adapter 时沿用 bootstrap 的空闲关闭配置(chromeIdleSeconds),
	 * 与启动时构造的 adapter 行为一致;未设走 adapter 默认。
	 */
	chromeIdleTimeoutMs?: number;
	/**
	 * 把浏览器来源写回 bootstrap yaml 持久化。由 index.ts 接线(绑定 config 路径);
	 * 未注入则热启用仍生效但重启不保留。
	 */
	persistChromeSource?: (source: ChromeSource) => Promise<void>;
	/**
	 * 热启用成功后回调,通知 index.ts 更新全局 puppeteer 引用(供进程退出时 dispose)。
	 */
	onPuppeteerEnabled?: (puppeteer: PuppeteerAdapter) => void;
	/**
	 * 卡片皮肤库(ADR-0014)。预览两条路都要它:走 ImageRenderer 的那条把它接成渲染器的
	 * 皮肤解析口,虚构 mock 那条直接拿清单调 `renderCardWithSkin`。不给 = 只有内置默认皮肤。
	 */
	cardSkins?: CardSkinStore;
	/**
	 * 把「截一张盘上皮肤」的口子交出去 —— 卡片工坊的 `look_card` 要用(ADR-0015 决策 19 的 🔗)。
	 * 握着 Chrome 的是这条路由,截图口只能从这里借;交出去的是闭包,热启用换了 Chrome 照样用新的。
	 */
	onSkinShot?: (shoot: (skinId: string, kind: CardKind) => Promise<string | null>) => void;
}

/**
 * 预览与测试推送请求里的卡片样式。只剩直播封面:字体与玻璃归皮肤自己的旋钮(从前这里还带 `font` / `fontAsset`,
 * 随设置里的退役字段一起没了)。
 */
const StyleSchema = z.object({
	/** 直播封面资产 id 列表(空 = B 站封面;>1 = 轮换,预览端取首张)。仅 live 卡。 */
	liveCoverImageIds: z.array(z.string()).optional(),
});

const ContentSchema = z
	.object({
		// 用哪条订阅的真数据(它的来源实现了 `fetchPreview` 才有);不给就是示例。醒目留言 / 上舰取它的名字。
		subscriptionId: z.string().min(1).optional(),
		// 作品卡取最近的第几条(1 = 最新那条);只对作品卡、且挑了订阅时有用。
		nth: z.number().int().positive().optional(),
		// sc / guard: text override (sc body / guard new captain uname).
		text: z.string().optional(),
		// guard: 档的 key(B 站是 `captain` / `commander` / `governor`)。档 key 只在体系内唯一:带了 `program`
		// (体系 id,ADR-0021 决策 26)就按（体系 id, 档 key）找,不带是旧请求、按登记先后找第一个。认不出的过不了
		// 校验(400):这里只校形,「认不认得」要读登记表,由 `createCardsRoute` 里套的那一层判。
		// 档的徽章图、背景色、宣告语都由这一档决定,渐变样式字段对上舰不生效。
		tierKey: z.string().optional(),
		// guard: 会员体系 id(B 站是 `guard`);不指定 = 沿用旧请求的找法(示例卡取第一套体系的最低一档)。
		program: z.string().optional(),
		// sc: 示例金额(CNY)，只决定显示金额，不推导档位或时长。
		amount: z.number().int().min(1).optional(),
		// sc: 皮肤的六档配色与展示时长，由示例输入独立指定。0秒不显示时长。
		rank: z.number().int().min(1).max(6).optional(),
		durationSec: z.number().int().nonnegative().optional(),
	})
	.optional();

/**
 * per-UP 那侧的**草稿**旋钮覆盖,按皮肤 id 分(与订阅的 `overrides.cardSkinKnobs` 同形,ADR-0014
 * 决策 17 的 🔗)。出图时与配置里的**全局那份**逐枚合并,只认这张预览实际画的那套皮肤那一格。
 * 全局作用域一个字都不传 —— 全局那份面板是存完再看的,服务端自己从配置里读。
 */
const PreviewKnobDraftSchema = z.record(CardSkinIdSchema, CardSkinKnobOverridesSchema).optional();

const PreviewRequestSchema = z.object({
	kind: z.enum(["live", "post", "superchat", "membership"]),
	style: StyleSchema,
	content: ContentSchema,
	/** 预览用哪套皮肤(ADR-0014);缺省 = 全局在用的那套。 */
	cardSkin: CardSkinIdSchema.optional(),
	cardSkinKnobs: PreviewKnobDraftSchema,
});

const EnableRenderingSchema = z
	.object({
		chromePath: z.string().min(1).optional(),
		chromeEndpoint: z.string().min(1).optional(),
	})
	// 报错在校验那一刻才取字(zod 4 的 `error` 写成函数)。
	.refine((d) => d.chromePath || d.chromeEndpoint, {
		error: () => t("cards.renderer.sourceRequired"),
	});

type PreviewStyle = z.infer<typeof StyleSchema>;

// PreviewResponse / TestPushResponse 在 @bilibili-notify/contract(web 同源消费)。

type PreviewKind = z.infer<typeof PreviewRequestSchema>["kind"];
type PreviewContent = z.infer<typeof ContentSchema>;

const TestPushRequestSchema = z.object({
	targetId: z.uuid(),
	kind: z.enum(["live", "post", "superchat", "membership"]),
	style: StyleSchema,
	content: ContentSchema,
	cardSkin: CardSkinIdSchema.optional(),
	cardSkinKnobs: PreviewKnobDraftSchema,
});

const RENDER_TIMEOUT_MS = 20_000;

/**
 * 测试推送图片的图说(caption)。纯图片推送在 QQ 富媒体消息里会被塞一个占位空格(QQ 要求
 * content 非空),显示成图片下方一段空白;给测试推送配一句带类型标签的文案顶替它,接收方
 * 一眼能认出是测试,History 列表也不再落「(无内容)」。
 */
export function testPushCaption(kind: PreviewKind): string {
	return t("cards.testPush.caption", { kind: CARD_KIND_NAMES[kind] });
}

/**
 * 没配 Chrome 时那句话(`not_configured`)。**三处共用一份** —— 说的是同一件事,分成几份写迟早会漂,
 * 而这句正是主人照着去修的那条路径(「失败的原因不许吞」)。
 */
function noChromeHint(): string {
	return t("cards.renderer.notConfigured");
}

/**
 * 「最终效果」的请求体。`manifest` 不在这儿校形 —— 它要过的是装包门那一整套。
 * 皮肤 id 在路径里(`/skins/:id/screenshot`,ADR-0036),不在体里。
 */
const SkinShotRequestSchema = z.object({
	kind: CardKindSchema,
	scene: z.string().max(40).optional(),
	manifest: z.unknown(),
});

export function createCardsRoute(opts: CardsRouteOptions): Hono {
	const app = new Hono();
	const log = opts.deps.runtime.serviceCtx.logger;
	// 会员档位读口:每次现读来源登记表。上舰预览按它找档、示例取它的最低一档,这条路由不认识任何平台的档位表。
	const tiers = createMembershipTierReader(opts.deps.runtime.sourceRegistry);
	// 请求体的「认不认得这个档的 key」要读登记表,不能在模块顶层的 schema 里判:在工厂里给两个请求体各套一层。
	// 报错的说法与形状同从前(`issues` 的路径仍是 content.tierKey)。
	const contentSchema = ContentSchema.unwrap()
		.superRefine((content, ctx) => {
			if (content?.tierKey === undefined) return;
			if (tiers.byKey(content.program, content.tierKey) === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["tierKey"],
					message: t("cards.preview.unknownTier"),
				});
			}
		})
		.optional();
	const previewRequestSchema = PreviewRequestSchema.extend({ content: contentSchema });
	const testPushRequestSchema = TestPushRequestSchema.extend({ content: contentSchema });

	/** 请求里挑的那条订阅;没挑是 `undefined`。挑了却没有这条,由两个口在出卡前回 404。 */
	function previewSubscriptionOf(content: PreviewContent): Subscription | undefined {
		const id = content?.subscriptionId;
		return id === undefined
			? undefined
			: opts.deps.store.getSubscriptions().find((sub) => sub.id === id);
	}

	/** 挑了订阅却没有这条:请求本身不成(404),不画示例顶替 —— 面板拿的订阅表旧了,该刷新。 */
	function missingSubscription(content: PreviewContent): boolean {
		return content?.subscriptionId !== undefined && previewSubscriptionOf(content) === undefined;
	}

	/** 卡上那位创作者的名字:事件名 → 资料名 → 身份标签(与真推送同一条链);没挑订阅是示例名。 */
	function creatorNameOf(sub: Subscription | undefined, eventName?: string): string | undefined {
		if (!sub) return undefined;
		return displayNameOf(
			{
				eventName,
				profileName: opts.deps.runtime.subscriptionStateStore.get(sub.id)?.cachedProfile?.name,
			},
			subscriptionIdentityLabelOf(subscriptionIdentityOf(sub), {
				sources: opts.deps.runtime.sourceRegistry,
			}),
		);
	}

	/** 订阅资料里存好的头像引用(与真推送一样出卡这一刻现读、零网络)。 */
	function profileAvatarOf(sub: Subscription): ImageRef | undefined {
		return opts.deps.runtime.subscriptionStateStore.get(sub.id)?.cachedProfile?.avatar;
	}

	/** 付醒目留言的人 / 新会员:挑中那条订阅的来源登录着的账号名;没挑、来源不用登录或没登录是 `undefined`。 */
	function accountNameOf(sub: Subscription | undefined): string | undefined {
		if (!sub) return undefined;
		const source = opts.deps.runtime.sourceRegistry.get(subscriptionIdentityOf(sub).sourceKey);
		return source?.auth?.account?.()?.name;
	}

	/** 醒目留言 / 上舰卡上收的那个人:挑中那条订阅的名字,没挑是示例名。 */
	function receiverNameOf(sub: Subscription | undefined): string {
		return creatorNameOf(sub) ?? t("cards.sample.creatorName");
	}

	/**
	 * 问那条订阅的来源要一份真数据。没挑订阅、来源不在册、来源没实现 `fetchPreview` 都是 `undefined`(用示例,
	 * 不算失败);来源回了失败或交回的不是这一种卡,是失败那一支(原话给面板)。来源「不许抛」,真抛了也按失败收。
	 */
	async function realPreviewOf(
		sub: Subscription | undefined,
		options: PreviewOptions,
		signal: AbortSignal,
	): Promise<Result<PreviewReport> | undefined> {
		if (!sub) return undefined;
		const identity = subscriptionIdentityOf(sub);
		const source = opts.deps.runtime.sourceRegistry.get(identity.sourceKey);
		if (!source?.fetchPreview) return undefined;
		try {
			const got = await source.fetchPreview(identity, options, signal);
			if (got.ok && got.kind !== options.kind) return fail("invalid", t("cards.preview.wrongKind"));
			return got;
		} catch (err) {
			log.error(logText("log.http.previewFetchFailed"), {
				sourceKey: identity.sourceKey,
				error: err,
			});
			return fail("unavailable", errorMessageOf(err));
		}
	}

	// 自动探测本机 Chrome —— dashboard「自动探测」按钮。未配 chromePath 时一键找到
	// 本地浏览器,免手填路径;探测不到返回 { path: null }。
	const detectChrome = opts.detectChrome ?? (() => resolveChromePath(undefined));
	app.get("/chrome", (c) => c.json({ path: detectChrome() }));

	// 当前 puppeteer adapter —— 可变 holder。启动时 = currentPuppeteer(可能 null);经
	// POST /renderer 运行时热启用/热切换后指向新 adapter,使后续 /preview 也用上,
	// 无需重启。currentSource 与之同步,供 GET /renderer 展示与同源幂等判断。
	let currentPuppeteer = opts.puppeteer;
	let currentSource: ChromeSource | null = opts.initialChromeSource ?? null;

	const sourceEquals = (a: ChromeSource | null, b: ChromeSource): boolean =>
		!!a && a.chromePath === b.chromePath && a.chromeEndpoint === b.chromeEndpoint;

	// 当前渲染浏览器来源 —— System 页「卡片渲染浏览器」区的数据源。persistable=false
	// 表示无可写 bootstrap 配置(legacy / desktop),切换仍生效但重启不保留。
	app.get("/renderer", (c) =>
		c.json({
			enabled: currentPuppeteer !== null,
			source: currentSource,
			persistable: Boolean(opts.persistChromeSource),
		}),
	);
	const createPuppeteer =
		opts.createPuppeteer ??
		((source: ChromeSource) =>
			createPuppeteerAdapter({
				chromePath: source.chromePath,
				chromeEndpoint: source.chromeEndpoint,
				idleTimeoutMs: opts.chromeIdleTimeoutMs,
				logger: log,
			}));

	// 一键热启用/热切换卡片渲染 —— dashboard 探测到本地 Chrome、或填入远程端点后
	// 调用:运行时构造 puppeteer、注入已跑的直播与作品路径、写回浏览器来源持久化,
	// 全程不重启。已启用时:同源 → alreadyEnabled 幂等;异源 → 先探测新浏览器,通了
	// 才 swap 并 dispose 旧 adapter(别把能用的配置换成坏的)。
	app.post("/renderer", async (c) => {
		const body = await c.req.json().catch(() => null);
		const parsed = EnableRenderingSchema.safeParse(body);
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", t("cards.renderer.sourceRequired"), {
					issues: issuesFromZod(parsed.error),
				}),
			);
		}
		const pipeline = opts.deps.runtime.pipeline;
		if (!pipeline) return respondFailure(c, fail("unavailable", pipelineNotReadyMessage()));
		const source = parsed.data;
		// 热切换 = 路由已握有在用 adapter;同源直接幂等返回,连 adapter 都不构造。
		const replacing = currentPuppeteer !== null;
		if (replacing && sourceEquals(currentSource, source)) {
			return c.json(ok({ alreadyEnabled: true }));
		}
		// 这里没有兜底的 `catch`:构造 / 换上 / 销毁抛出来的是 bug 或环境的事(抛错只留给 bug),
		// 交给全局出错处理 —— 原话进错误日志,客户端拿固定一句。可预期的两种失败(探测连不上、
		// 配置写不进去)是下面显式回的 `unavailable`,原因原样写进 `message`。
		const pup = createPuppeteer(source);
		// 连通性探测:远程端点没有 `/chrome` 那样的存在性预验,连不上只会在
		// 之后首次渲染才暴露;热切换则无论来源都要先验 —— 失败就不动现有渲染器。
		if (source.chromeEndpoint || replacing) {
			try {
				const probe = await pup.page();
				await probe.close();
			} catch (err) {
				await pup.dispose();
				const detail = err instanceof Error ? err.message : String(err);
				log.warn(logText("log.browser.probeFailed"), { source: sourceForLog(source), error: err });
				return respondFailure(
					c,
					fail("unavailable", t("cards.renderer.connectFailed", { detail })),
				);
			}
		}
		if (replacing) {
			pipeline.swapImageRendering(pup);
		} else {
			const enabled = pipeline.enableImageRendering(pup);
			if (!enabled) {
				// 推送链路侧已有渲染器但路由不知情(理论不该发生的接线错位):保持旧行为,
				// 释放多余 adapter。
				await pup.dispose();
				return c.json(ok({ alreadyEnabled: true }));
			}
		}
		const old = currentPuppeteer;
		currentPuppeteer = pup;
		currentSource = source;
		opts.onPuppeteerEnabled?.(pup);
		// 持久化先于销毁旧浏览器:写盘失败时旧浏览器留着不 dispose,不会出现
		// "报切换失败,但其实新浏览器已经在用、旧的已经没了"的错觉(旧根因:persist
		// 曾排在 dispose 之后 —— 写盘失败时旧浏览器已被销毁,响应却仍是 500)。
		try {
			await opts.persistChromeSource?.(source);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			log.error(logText("log.browser.sourceWriteFailed"), { error: err });
			return respondFailure(c, fail("unavailable", t("cards.renderer.persistFailed", { detail })));
		}
		if (old) {
			// 旧浏览器关掉(本地)/断开(远程)。若旧 adapter 恰有渲染在飞,那一张会
			// 失败一次 —— 切换是人工低频操作,可接受。
			await old.dispose();
		}
		log.info(logText("log.browser.rendererEnabled"), { replacing, source: sourceForLog(source) });
		return c.json(ok(source));
	});

	// One ImageRenderer reused across requests. Lazy — only constructed when
	// the first real-fetch / sc / guard path actually runs, so deployments
	// without BN_CHROME_PATH don't spin one up needlessly.
	//
	// 每次请求都 updateConfig 一遍传入的 style — 否则用户在 Cards 页改完颜色后
	// 第一次 /preview 构造一个 renderer 后,后续改色就不生效(renderer 是 lazy 单例)。
	// `@font-face` 规则的读取口 —— **本路由只此一份**,mock 路径(live / dyn 走示例数据)
	// 与 ImageRenderer 都走它。一款中文字库 base64 后二三十兆,而镜像里 V8 堆上限只有
	// 512MB;各读各的话,一屏几张卡就能把堆顶起来。共用之后两边拿到的是同一个字符串
	// 引用,内存里始终只有一份。
	//
	// 缓存里留的是**拼好的规则**而不是 data URL:规则本身就把 data URL 包在里头,存前者
	// 就等于让后者可被回收,同一串东西不必占两份。
	//
	// 惰性构造:`POST /renderer`、`GET /chrome` 这些路由不碰字体,它们的测试给的
	// 是最小 deps —— 路由建起来的这一刻别去读 runtime 上的东西,真要读字体时再取。
	const loadFontFace = (id: string): Promise<string> => {
		if (!id) return Promise.resolve("");
		return opts.deps.runtime.loadFontFace(id);
	};

	/**
	 * **预览用哪套皮肤 —— 唯一那处解析。**
	 *
	 * 「请求没指皮肤」只有一个意思:用全局在用的那套。这里之前是三处各兜一次缺省,而
	 * 走渲染器的那条(SC / 上舰 / 真实拉取)压根没兜,落进渲染器自己的内置默认 —— 于是
	 * 同一屏里直播卡是新皮肤、SC 卡是出厂样子(2026-09-14 主人报的那一组现象)。缺省
	 * 只准有一个,就在这儿。
	 */
	function previewSkinId(id?: string): string {
		return id || opts.deps.store.getGlobals().defaults.cardSkin;
	}

	/**
	 * 预览用哪套皮肤的清单。id 由 {@link previewSkinId} 解析好再进来;店里取不到
	 * (皮肤被删了)就退回内置默认 —— 预览不该因为指了个不存在的 id 而报错,它本来就是
	 * 「看看长什么样」。
	 */
	async function previewManifest(skinId: string): Promise<CardSkinManifest> {
		const store = opts.cardSkins;
		if (!store) return DEFAULT_CARD_SKIN;
		await store.ensureReady();
		return store.get(skinId) ?? DEFAULT_CARD_SKIN;
	}

	/**
	 * 预览要用的那份**旋钮覆盖**:全局那份按皮肤 id 从配置里取(存覆盖不存值,没拧过就没有键),
	 * per-UP 预览再把请求里的草稿逐枚叠上去(ADR-0014 决策 17 的 🔗)。合并用的是出图那头
	 * **同一个**函数 —— 两边各合一份的话,预览与推出去的卡会在配色上悄悄分家。
	 */
	function previewKnobValues(
		skinId: string,
		draft: CardSkinChoice["cardSkinKnobs"],
	): Readonly<CardSkinKnobOverrides> | undefined {
		return effectiveCardSkinKnobs(
			opts.deps.store.getGlobals().defaults.cardSkinKnobs,
			draft,
			skinId,
		);
	}

	let imageRenderer: ImageRenderer | null = null;
	// 缓存绑定的 adapter 快照 —— 热切换(POST /renderer)会把 currentPuppeteer 换成
	// 新 adapter 并 dispose 旧的,若不比对直接复用,imageRenderer 会一直攥着已销毁的
	// 旧 adapter(ImageRenderer.puppeteer 是 readonly,updateConfig 换不了它)。
	let imageRendererPuppeteer: PuppeteerAdapter | null = null;
	async function getImageRenderer(): Promise<ImageRenderer | null> {
		if (!currentPuppeteer) return null;
		const config = {
			// 字体归皮肤自己的旋钮(从前这里读设置里的 `font` / `fontAsset`,退役了),预览与出图都走旋钮。
			font: "PingFang SC, sans-serif",
			// 旋钮覆盖:SC / 上舰的预览走渲染器这条路,不给就只有另外两种卡的预览跟着
			// 旋钮变 —— 「预览好看、推出去变样」的同一个坑,换个卡种再踩一次。
			cardSkinKnobs: opts.deps.store.getGlobals().defaults.cardSkinKnobs,
		};
		if (!imageRenderer || imageRendererPuppeteer !== currentPuppeteer) {
			imageRenderer = new ImageRenderer({
				serviceCtx: opts.deps.runtime.serviceCtx,
				puppeteer: currentPuppeteer,
				config,
				// 背景图 id → data URL(读 <dataRoot>/assets/card-bg);sc/guard/真实拉取走 generate* 解析。
				resolveAsset: (id) => readCardBgDataUrl(opts.deps.runtime.dataRoot, id),
				// 字体 id → 拼好的 @font-face(读 <dataRoot>/assets/font)。
				resolveFontFace: loadFontFace,
				// 卡上的时间按全局时区排(与推送同一个现取口):预览与真推送画出来一个样。
				timezone: () => opts.deps.store.getGlobals().timezone,
				// 图库引用 → data URL:与推送出图(runtime/pipeline.ts)同一个解析口,预览里带引用的图才不会
				// 画成占位、与真推送分家。
				resolveImageRef: imageRefDataUrl(opts.deps.runtime.imageStore),
				// 皮肤:与推送出图问的是同一家店(app.ts 传进来的那一个实例)。
				resolveCardSkin: (id) => opts.cardSkins?.get(id) ?? undefined,
				resolveCardSkinAsset: async (skinId, name) =>
					opts.cardSkins ? await readCardSkinAssetDataUrl(opts.cardSkins, skinId, name) : undefined,
				// 预览:每来一次请求就热更一次样式,打 info 会刷屏且像"已保存"。真正生效的
				// INFO 由推送渲染器(runtime/pipeline.ts)在 config-changed 后打。
				quietConfigUpdates: true,
			});
			imageRendererPuppeteer = currentPuppeteer;
		} else {
			imageRenderer.updateConfig(config);
		}
		return imageRenderer;
	}

	/**
	 * 只要**截图管线**(串行闸 + 页池),不碰 config —— 皮肤的「最终效果」喂的是现成 HTML,
	 * 配置对它没有影响,而 `getImageRenderer()` 会热更 config:拿它去截图会把并发的
	 * `/preview` 刚设好的样式冲掉(「预览好看、推出去变样」的同一族)。
	 *
	 * 仍复用同一个实例 —— 闸是实例私有的,另起一个等于两条并发的 Chrome 渲染。
	 */
	async function getScreenshotRenderer(): Promise<ImageRenderer | null> {
		if (!currentPuppeteer) return null;
		if (imageRenderer && imageRendererPuppeteer === currentPuppeteer) return imageRenderer;
		// 还没建过:照常建一个(config 随下一次 `/preview` 热更)。
		return await getImageRenderer();
	}

	/**
	 * 截一张**盘上那份**皮肤(默认场景),回 data URL;没 Chrome 回 null。与「最终效果」同一条路
	 * (清单 → HTML → 截图),只是清单取自皮肤库而不是草稿。
	 */
	async function shootSavedSkin(skinId: string, kind: CardKind): Promise<string | null> {
		const store = opts.cardSkins;
		if (!store) return null;
		const renderer = await getScreenshotRenderer();
		if (!renderer) return null;
		const manifest = store.get(skinId);
		if (!manifest) throw new Error(t("cards.skin.notFound", { skinId }));
		const membershipTier = tiers.lowest();
		const gone = membershipTierUnavailable(kind, membershipTier);
		if (gone) throw new Error(gone.message);
		const out = await renderSkinPreviewHtml({ store, skinId, kind, manifest, membershipTier });
		if (!out.ok) throw new Error((out.issues ?? [out]).map((issue) => issue.message).join("；"));
		const { buffer } = await renderer.screenshotHtml(out.html);
		return `data:image/jpeg;base64,${buffer.toString("base64")}`;
	}
	opts.onSkinShot?.(shootSavedSkin);

	// 渲染一张样例卡片 → JPEG / PNG Buffer。/preview 与 /test 共用。渲染失败抛 Error
	// (消息直接面向用户)。SC / Guard 走 ImageRenderer;作品 / 直播挑了订阅且来源实现了 `fetchPreview`
	// 就画来源交的真数据,否则(或来源回了失败)画虚构 mock 数据,`sampleReason` 带来源的原话。
	// 调用方须先确认 currentPuppeteer 存在、挑的订阅在。
	async function renderPreviewCard(
		kind: PreviewKind,
		style: PreviewStyle,
		content: PreviewContent,
		/** 请求里指的皮肤(缺省 = 全局在用的那套)与 per-UP 草稿旋钮(全局作用域不给)。 */
		requested: CardSkinChoice = {},
		signal: AbortSignal = new AbortController().signal,
	): Promise<{ buffer: Buffer; mime: string; sampleReason?: string }> {
		const puppeteer = currentPuppeteer;
		if (!puppeteer) throw new Error(t("cards.renderer.notReady"));
		// 下面四条出图路子(SC / 上舰 / 真实拉取 / 虚构 mock)都吃这一个 id,走渲染器的那三条
		// 还带着草稿旋钮(渲染器自己与 config 里的全局那份合并);mock 那条见 `previewKnobValues`。
		const skinId = previewSkinId(requested.cardSkin);
		const skin: CardSkinChoice = { cardSkin: skinId, cardSkinKnobs: requested.cardSkinKnobs };
		const sub = previewSubscriptionOf(content);

		if (kind === "superchat") {
			const renderer = await getImageRenderer();
			if (!renderer) throw new Error(t("cards.renderer.notReady"));
			// 付款人 = 挑中那条订阅的来源登录着的账号(「我在别人直播间发条 SC 会长啥样」);收的人 = 那条订阅。
			const payer = accountNameOf(sub);
			const receiver = receiverNameOf(sub);
			// 示例数据没有头像:这张预览不传(`viewer.avatar` / `creator.avatar` 只收图库引用,示例里没有可给的;
			// 真推送里观众头像取自帧里的地址、主播头像读订阅资料)。
			const buffer = await renderer.generateSuperchatCard(
				{
					viewer: { name: payer ?? t("cards.sample.viewerName") },
					creator: { name: receiver },
					text: content?.text?.trim() || t("cards.sample.superchatText"),
					amount: content?.amount ?? 30,
					currency: "CNY",
					tier: { rank: content?.rank ?? 1, durationSec: content?.durationSec ?? 60 },
				},
				// 预览样式已由 getImageRenderer() 烤进渲染器 config,故只带皮肤(id + 草稿旋钮)。
				skin,
			);
			return { buffer, mime: "image/jpeg" };
		}
		if (kind === "membership") {
			// 读口给不出档(没有来源声明会员档位):先于任何渲染、取名、抓图说清原因;预览与测试推送都据此回
			// `unavailable` 那一支(`/preview`、`/test` 的 catch 就是这么回的)。
			if (content?.tierKey === undefined) {
				const gone = membershipTierUnavailable(kind, tiers.lowest(content?.program));
				if (gone) throw new Error(gone.message);
			}
			const renderer = await getImageRenderer();
			if (!renderer) throw new Error(t("cards.renderer.notReady"));
			// 新会员 = 挑中那条订阅的来源登录着的账号;显式 text 覆写仍优先。收的人 = 那条订阅。
			const uname = content?.text?.trim() || accountNameOf(sub) || t("cards.sample.memberName");
			const receiver = receiverNameOf(sub);
			// 请求里的 `program` + `tierKey` 是（体系 id, 档 key),服务端按这一对找档(没带 tierKey = 那个体系最低一档);
			// 档的徽章、档色、宣告语都取自那份声明,与真推送同一份。认不出的 key 在请求校验那一步就是 400,走不到这里。
			const tier =
				content?.tierKey === undefined
					? tiers.lowest(content?.program)
					: tiers.byKey(content.program, content.tierKey);
			if (!tier)
				throw new Error(t("cards.preview.noSuchTier", { tierKey: content?.tierKey ?? "" }));
			// 来源描述符里已有图库引用就直接用;缺了才经该来源的懒取口补抓。没有来源声明的会员档
			// 自然也没有懒取口,预览照出、徽章块自己收起。
			let icon = tier.icon?.ref === undefined ? undefined : { ref: tier.icon.ref };
			if (!icon) {
				const declared = opts.deps.runtime.sourceRegistry
					.list()
					.find((view) =>
						(view.descriptor.membershipPrograms ?? []).some(
							(program) => Array.isArray(program.tiers) && program.tiers.includes(tier),
						),
					);
				const program = declared?.descriptor.membershipPrograms?.find(
					(candidate) => Array.isArray(candidate.tiers) && candidate.tiers.includes(tier),
				);
				const reader = declared?.liveInteractions;
				if (declared && program && reader) {
					const fetched = await reader.fetchTierIcon(
						{ sourceKey: declared.sourceKey, externalId: "" },
						program.id,
						tier.key,
						signal,
					);
					if (fetched.ok) icon = { ref: fetched.ref };
				}
			}
			// 示例数据没有头像:预览不传(同上)。
			const buffer = await renderer.generateMembershipCard(
				{
					viewer: { name: uname },
					creator: { name: receiver },
					tier: {
						name: tier.name,
						rank: tier.rank,
						...(icon ? { icon } : {}),
						color: tier.color,
						colorEnd: tier.colorEnd,
						announcement: tier.announcement,
					},
				},
				// 预览样式已由 getImageRenderer() 烤进渲染器 config,故只带皮肤(id + 草稿旋钮)。
				skin,
			);
			return { buffer, mime: "image/jpeg" };
		}
		// 作品 / 直播:挑了订阅、来源实现了 `fetchPreview` 就画它交的真数据(与真推送同一个出卡入口)。
		// 来源回了失败就落到下面的示例,原话随回应交给面板(4-14 主人定:回落示例并说原因)。
		let sampleReason: string | undefined;
		const real = await realPreviewOf(
			sub,
			kind === "post" ? { kind: "post", nth: content?.nth ?? 1 } : { kind: "live" },
			signal,
		);
		if (real && !real.ok) sampleReason = real.message;
		if (sub && real?.ok) {
			const renderer = await getImageRenderer();
			if (!renderer) throw new Error(t("cards.renderer.notReady"));
			if (real.kind === "post") {
				// 外层作者头像:作品自己没带才用订阅资料里的(与推送出卡同一条);不改来源交的那份。
				const post = real.report.post;
				const avatar = post.creator.avatar ?? profileAvatarOf(sub);
				const forCard: Post =
					avatar === undefined || avatar === post.creator.avatar
						? post
						: { ...post, creator: { ...post.creator, avatar } };
				return { buffer: await renderer.generatePostCard(forCard, skin), mime: "image/jpeg" };
			}
			// 直播:翻成中立的卡片输入(封面与头像本来就是图库引用),恒按「直播中」画 —— 没在播的房间也看得到样子。
			const startedAt = real.startedAt === undefined ? undefined : Date.parse(real.startedAt);
			const profileAvatar = profileAvatarOf(sub);
			const input = liveCardInputFromDetails(real.details, {
				status: "streaming",
				...(startedAt === undefined ? {} : { startedAt }),
				authorName: creatorNameOf(sub, real.details.creator?.name) ?? "",
				...(profileAvatar === undefined ? {} : { profileAvatar }),
			});
			const buffer = await renderer.generateLiveCard(input, {
				// 自定义直播封面:跳过悬空引用(文件已删的 id),取第一张盘上存在的图 —— 与 mock 预览 / 生产推送
				// 同一条守卫,否则第一张是幽灵 id 时会静默回退来源的原始封面。
				liveCoverImage: await firstExistingCardBg(
					opts.deps.runtime.dataRoot,
					style.liveCoverImageIds,
				),
				...skin,
			});
			return { buffer, mime: "image/jpeg" };
		}
		// Live + Dyn 无真实数据(或回退):虚构 mock 数据,走 renderCard + screenshot 流水线
		// (不经 ImageRenderer,未登录也能调色)。直播封面在此解析成 data URL 注入;
		// 取「第一张盘上存在的图」,跳过悬空引用。卡片背景图不在这条路上了 —— 它归皮肤的
		// `image` 旋钮,由下面的 `resolveKnobAssets` 解析。
		const dataRoot = opts.deps.runtime.dataRoot;
		// 直播封面与自带字体互不依赖(各自独立的资产解析),并发发起省一次串行 I/O。
		const coverDataUrl =
			kind === "live"
				? await firstExistingCardBg(dataRoot, style.liveCoverImageIds).then((id) =>
						readCardBgDataUrl(dataRoot, id),
					)
				: "";
		const spec = buildPreviewSpec(kind, coverDataUrl);
		// 皮肤那条路与推送出图**同一个函数**(`renderCardWithSkin`)—— 各拼一份的话必然出现
		// 「预览是这套皮肤、推出去是另一副样子」,而两边都说不出哪儿错了。
		const manifest = await previewManifest(skinId);
		// 与编辑器预览那条路共用同一份预取(`card-skins/asset-url.ts`)。
		const assets = opts.cardSkins
			? await prefetchCardSkinAssets(opts.cardSkins, skinId, manifest, spec.kind)
			: new Map<string, string>();
		// 🔴 **`knobValues` 一个人不够。** 字体与图这两档旋钮的值是资产库里的一个 id,
		// 要读盘才变得成 CSS,所以 `cardSkinKnobCss` 那条同步路径对它们恒回 null ——
		// 少了这一句,主人在旋钮面板里选了「卡片背景图」,别的旋钮照常跟着变,唯独背景图
		// 与字体**静静地什么也不做**,而推送出去的卡是对的(ImageRenderer 那条路调了它)。
		// 「预览好看、推出去变样」的镜像版,2026-09-19 审查抓到。
		const knobValues = previewKnobValues(skinId, requested.cardSkinKnobs);
		const knobAssets = await resolveKnobAssets(manifest.knobs, knobValues, {
			image: (id) => readCardBgDataUrl(dataRoot, id),
			fontFace: loadFontFace,
			// 超出 CSS 自定义属性 2 MiB 上限的图要压一下,否则 Chrome 整条丢弃、
			// 预览画兜底渐变 —— 而推送那头压了,两边就分家了。
			shrinkImage: (url, budget) => shrinkImageForCssVar(puppeteer, url, budget),
		});
		for (const warning of knobAssets.warnings)
			log.warn(packageText("image.log.knobBudgetExceeded"), warning);
		// 自带字体优先于家族名(与 ImageRenderer#resolveFont 同一套判断);资产悬空时
		// fontFace 是空串,静静回落家族名。
		// 两支只差那个字面量(重载靠它收窄 props 的类型),选项一份就够 —— 分成两份写,
		// 改一支漏一支的症状是「直播卡对、动态卡不对」,而两处代码看着都对。
		const common = {
			title: spec.title,
			font: "PingFang SC, sans-serif",
			resolveAsset: (name: string) => assets.get(name),
			knobValues,
			knobAssets,
		};
		const html =
			spec.kind === "live"
				? await renderCardWithSkin("live", spec.props, manifest, common)
				: await renderCardWithSkin("post", spec.props, manifest, common);
		const buffer = await screenshotHtml(puppeteer, html);
		return { buffer, mime: "image/png", ...(sampleReason === undefined ? {} : { sampleReason }) };
	}

	app.post("/preview", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = previewRequestSchema.safeParse(body);
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", t("cards.preview.badRequest"), { issues: issuesFromZod(parsed.error) }),
			);
		}
		// 没配浏览器:要主人先去配(面板据 `not_configured` 摆出「一键检测并启用 Chrome」),不是等一会儿就好。
		if (!currentPuppeteer) return respondFailure(c, fail("not_configured", noChromeHint()));
		const { kind, style, content, cardSkin, cardSkinKnobs } = parsed.data;
		if (missingSubscription(content)) {
			return respondFailure(c, fail("not_found", t("cards.preview.noSuchSubscription")));
		}
		// 「画一张、回报结果」:画出来是 200 + `ok`,画不出来(渲染抛错)是 200 + 失败那一支 ——
		// 请求本身没毛病,只是这一趟没成。原话进 `message`,主人要照着去查(Chrome 起不来、B 站取数失败……)。
		try {
			const { buffer, mime, sampleReason } = await renderPreviewCard(
				kind,
				style,
				content,
				{ cardSkin, cardSkinKnobs },
				c.req.raw.signal,
			);
			return c.json<PreviewResponse>(
				ok({
					dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
					...(sampleReason === undefined ? {} : { sampleReason }),
				}),
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(logText("log.http.cardRenderFailed"), { kind, stage: "preview", error: err });
			return c.json<PreviewResponse>(
				fail("unavailable", t("cards.preview.renderFailed", { message: msg })),
			);
		}
	});

	/**
	 * POST /api/cards/skins/:id/screenshot —— 编辑器那颗「最终效果」(ADR-0014 决策 22)。
	 *
	 * 实时预览回 HTML 由**看的人的浏览器**画,推出去那张是 **server 上的 Chrome** 画的,
	 * 字体渲染像素级对不上;这颗按钮补的正是那一刀。路径落在 `/api/cards/skins/` 底下(「谁的」放前面),
	 * 但处理函数在这条路由而不是皮肤库那条(`routes/cards-skins.ts`):握着 Chrome 的是这儿 ——
	 * 而「清单 → HTML」那一步两边**共用同一个件**,预览与截图因此结构性地同源。
	 * (两条路由共一个前缀、各管各的口:`app.ts` 里 `/api/cards` 先挂,截图口由这条直接认领。)
	 */
	app.post("/skins/:id/screenshot", async (c) => {
		const skinId = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(skinId).success) {
			return respondFailure(c, fail("invalid", t("cards.skinShot.badId")));
		}
		const parsed = SkinShotRequestSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", t("cards.skinShot.badRequest"), {
					issues: issuesFromZod(parsed.error),
				}),
			);
		}
		if (!opts.cardSkins)
			return respondFailure(c, fail("unavailable", t("cards.skinShot.storeNotReady")));
		const renderer = await getScreenshotRenderer();
		if (!renderer) return respondFailure(c, fail("not_configured", noChromeHint()));

		const { kind, scene, manifest } = parsed.data;
		const membershipTier = tiers.lowest();
		const gone = membershipTierUnavailable(kind, membershipTier);
		if (gone) return respondFailure(c, gone);
		const out = await renderSkinPreviewHtml({
			store: opts.cardSkins,
			skinId,
			kind,
			scene,
			manifest,
			membershipTier,
		});
		// 草稿没过装包门是请求本身的毛病:400,逐条意见进 `issues`。
		if (!out.ok)
			return respondFailure(
				c,
				failureOfChecks(
					"invalid",
					t("cards.skinShot.draftNoun"),
					(out.issues ?? [out]).map((issue) => issue.message),
				),
			);

		// 同 `/preview`:截不出来是 200 + 失败那一支。
		try {
			const { buffer, height } = await renderer.screenshotHtml(out.html);
			return c.json<CardSkinShotResponse>(
				ok({
					dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
					width: out.width,
					height,
					// 超了出图那头会**静默**回落默认皮肤(决策 19);作者只有在这儿能提前知道。
					// 减掉上下两道出血 —— 出图那头的闸也这么算,两把尺子不一样的话,编辑器
					// 会为一张其实发得出去的卡报警(反过来更糟:说没事,推的时候静默回落)。
					overHeight: height - out.bleed * 2 > CARD_SKIN_LIMITS.maxHeight,
					warnings: out.warnings,
					scene: out.scene,
				}),
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(logText("log.http.cardRenderFailed"), { kind, stage: "skinScreenshot", error: err });
			return c.json<CardSkinShotResponse>(
				fail("unavailable", t("cards.skinShot.failed", { message: msg })),
			);
		}
	});

	// POST /api/cards/test — 渲染当前预览卡片(同 /preview 的草稿样式)并真实
	// 推送给一个 PushTarget。图片 Tab「测试推送」用,所见即所推。
	app.post("/test", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = testPushRequestSchema.safeParse(body);
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", t("cards.testPush.badRequest"), { issues: issuesFromZod(parsed.error) }),
			);
		}
		const { targetId, kind, style, content, cardSkin, cardSkinKnobs } = parsed.data;

		if (!currentPuppeteer) return respondFailure(c, fail("not_configured", noChromeHint()));
		const pipeline = opts.deps.runtime.pipeline;
		if (!pipeline) return respondFailure(c, fail("unavailable", pipelineNotReadyMessage()));
		const target = opts.deps.store.getTargets().find((each) => each.id === targetId);
		if (!target) return respondFailure(c, fail("not_found", t("cards.testPush.noTarget")));
		if (missingSubscription(content)) {
			return respondFailure(c, fail("not_found", t("cards.preview.noSuchSubscription")));
		}

		// 试一次、回报结果(同 `POST /api/targets/:id/test`):渲染没成、投递没成都是 200 + 失败那一支,耗时只在送达那一支。
		let card: { buffer: Buffer; mime: string; sampleReason?: string };
		try {
			card = await renderPreviewCard(
				kind,
				style,
				content,
				{ cardSkin, cardSkinKnobs },
				c.req.raw.signal,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(logText("log.http.cardRenderFailed"), { kind, stage: "test", error: err });
			return c.json<TestPushResponse>(
				fail("unavailable", t("cards.preview.renderFailed", { message: msg })),
			);
		}

		const payload: NotificationPayload = {
			kind: "image",
			image: { buffer: card.buffer, mime: card.mime },
			// 配一句图说,顶替纯图片在 QQ 富媒体消息里的占位空格(否则图片下方一段空白)。
			caption: testPushCaption(kind),
		};
		const result = testResultOfDelivery(await pipeline.push.sendToTarget(target.id, payload));
		// 推出去的是示例卡(来源回了失败):送达了也要说清为什么不是真数据。
		return c.json<TestPushResponse>(
			result.ok && card.sampleReason !== undefined
				? { ...result, sampleReason: card.sampleReason }
				: result,
		);
	});

	return app;
}

// ── Mock pipeline (fall-through path) ────────────────────────────────────────

/**
 * 虚构 mock 那条路要画的东西。**卡宽不在这儿** —— 它由皮肤(`card.width`)定,
 * `renderCardWithSkin` 自己取,这里再写一个 600 就是第二个事实源。
 */
type PreviewSpec =
	| { kind: "live"; props: LiveCardView; title: string }
	| { kind: "post"; props: PostCardView; title: string };

function buildPreviewSpec(
	kind: "live" | "post",
	/** 已解析的直播封面 data URL(mock SSR 路径不经 generate*,需在此注入;仅 live 卡消费)。 */
	coverDataUrl?: string,
): PreviewSpec {
	if (kind === "live") {
		return {
			kind: "live",
			props: buildLivePreviewProps(coverDataUrl),
			title: t("cards.sample.titleLive"),
		};
	}
	return { kind: "post", props: buildDynamicPreviewProps(), title: t("cards.sample.titlePost") };
}

const SVG_COVER =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 338'%3E%3Crect width='600' height='338' fill='%23FB7299'/%3E%3Ctext x='50%25' y='50%25' fill='white' font-size='32' text-anchor='middle' dominant-baseline='middle'%3ECover%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_PINK =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23FB7299'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='28' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_BLUE =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%2300AEEC'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='30' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E";

/**
 * 直播卡的示例:直接写块吃的那一份(`LiveCardView`),卡上那句时间写死、不读时钟 ——
 * 同一份样式连按几次预览,画出来的必须是同一张。
 *
 * @param coverDataUrl 主人设的自定义直播封面(已解析成 data URL);有就盖在示例封面上。
 */
function buildLivePreviewProps(coverDataUrl?: string): LiveCardView {
	return {
		status: "streaming",
		creatorName: t("cards.sample.creatorName"),
		creatorAvatarUrl: SVG_AVATAR_BLUE,
		title: t("cards.sample.live.title"),
		category: t("cards.sample.live.category"),
		description: t("cards.sample.live.description"),
		cover: coverDataUrl || SVG_COVER,
		hasCover: true,
		time: "2026-05-09 19:00:00",
		currentViewers: t("cards.sample.stats.currentViewers"),
		likes: t("cards.sample.stats.likes"),
		totalViewers: t("cards.sample.stats.totalViewers"),
		followers: t("cards.sample.stats.followers"),
		followersDelta: "+128",
	};
}

function buildDynamicPreviewProps(): PostCardView {
	const text = h(
		"div",
		{
			style: "font-size:14px;line-height:1.7;color:#444;white-space:pre-line;",
		},
		t("cards.sample.post.text"),
	);
	// 附加内容块的示例(预约样式),让用户在预览里看到 attachment 块独立排版的位置。
	const attachment = h(
		"div",
		{ style: "background:rgba(0,0,0,0.04);border-radius:8px;padding:10px;" },
		[
			h(
				"div",
				{ style: "font-size:14px;font-weight:bold;color:#18191C;" },
				t("cards.sample.post.attachmentTitle"),
			),
			h(
				"div",
				{ style: "font-size:12px;color:#999;margin-top:4px;" },
				t("cards.sample.post.attachmentLine"),
			),
		],
	);
	// 转发示例:被转发的原作品用同一套版式递归渲染,标签贴在内层作者名后。
	const repost = {
		creatorAvatarUrl: SVG_AVATAR_PINK,
		creatorName: t("cards.sample.post.repostCreator"),
		creatorIsPremium: false,
		time: "2026-05-08 10:30:00",
		label: t("cards.sample.post.repostLabel"),
		isReposted: true as const,
		topic: undefined,
		text: h(
			"div",
			{ style: "font-size:14px;line-height:1.7;color:#444;" },
			t("cards.sample.post.repostText"),
		),
		attachment: null,
		stats: undefined,
	};
	return {
		node: {
			creatorAvatarUrl: SVG_AVATAR_BLUE,
			creatorName: t("cards.sample.creatorName"),
			creatorIsPremium: true,
			time: "2026-05-09 18:24:00",
			topic: t("cards.sample.post.topic"),
			text,
			attachment,
			repost,
			stats: {
				shares: t("cards.sample.stats.shares"),
				comments: "5,891",
				likes: t("cards.sample.stats.likes"),
			},
		},
	};
}

async function screenshotHtml(pup: PuppeteerAdapter, html: string): Promise<Buffer> {
	const page = await pup.page();
	try {
		await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
		const root = await page.$("body");
		const box = root ? await root.boundingBox() : null;
		await root?.dispose();
		const screenshot = await page.screenshot({
			type: "png",
			fullPage: !box,
			clip: box ?? undefined,
		});
		return Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot);
	} finally {
		await page.close();
	}
}

function sourceForLog(source: ChromeSource) {
	return source.chromeEndpoint
		? { chromeEndpoint: logUrl(source.chromeEndpoint) }
		: { chromePath: source.chromePath };
}
