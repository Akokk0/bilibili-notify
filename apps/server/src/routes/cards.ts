/**
 * `POST /api/cards/preview` — render a sample card via puppeteer-core and
 * return base64 PNG. Used by the Cards page's right-side live preview.
 *
 * Two routing paths per kind, picked by what the request body's `content`
 * field carries:
 *
 *   live + content.roomId  → fetch real LiveRoomInfo + MasterInfo via
 *                            BilibiliAPI, render through ImageRenderer
 *                            (same code path as production push).
 *   dyn  + content.uid     → fetch the user's space dynamic feed,
 *                            pick the offset-th item, render via
 *                            ImageRenderer.generateDynamicCard.
 *   sc   + content.text    → text override on top of the SCCard mock.
 *   guard+ content.text    → text override (= new captain uname) on the
 *                            GuardCard mock.
 *   any kind + empty content → falls through to the fabricated mock data
 *                              path (the original behaviour) so the
 *                              gradient picker stays usable without a
 *                              logged-in account.
 *
 * 503 path — when the operator hasn't set BN_CHROME_PATH (or chromePath in
 * yaml) we don't try to launch puppeteer. The route reports the missing
 * config so the Cards page can render an actionable hint.
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { PreviewResponse, TestPushResponse } from "@bilibili-notify/contract";
import {
	buildFontFace,
	type Component,
	DynamicCard,
	type DynamicCardProps,
	h,
	ImageRenderer,
	LiveCard,
	type LiveCardProps,
	renderCard,
	USER_FONT_FAMILY,
} from "@bilibili-notify/image";
import {
	type CardBlock,
	type CardLayout,
	CardLayoutSchema,
	type GlobalConfig,
	type NotificationPayload,
	type Subscription,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import type { ChromeSource } from "../config/persist.js";
import {
	deleteCardBg,
	firstExistingCardBg,
	isValidCardBgId,
	listCardBg,
	readCardBg,
	readCardBgDataUrl,
	saveCardBg,
} from "../runtime/card-assets.js";
import {
	createFontAssetReader,
	deleteFontAsset,
	isValidFontAssetId,
	listFontAssets,
	readFontAsset,
	saveFontAsset,
} from "../runtime/font-assets.js";
import {
	createPuppeteerAdapter,
	resolveChromePath,
	type StandalonePuppeteer,
} from "../runtime/puppeteer.js";
import type { RouteDeps } from "./types.js";

export interface CardsRouteOptions {
	deps: RouteDeps;
	puppeteer: StandalonePuppeteer | null;
	/**
	 * 启动时实际生效的浏览器来源(bootstrap 里 endpoint 赢过 path 的那一个),
	 * 供 GET /render-source 展示与同源幂等判断;未启用时缺省。
	 */
	initialChromeSource?: ChromeSource;
	/**
	 * BilibiliAPI from authSystem. When null, real-data fetch paths
	 * (live + dyn with content) return an actionable error.
	 */
	api: BilibiliAPI | null;
	/**
	 * 探测本机 Chrome 路径(默认 resolveChromePath 扫常见安装位置);注入便于测试。
	 * 供 GET /detect-chrome 的「自动探测」按钮。
	 */
	detectChrome?: () => string | null;
	/**
	 * 构造 puppeteer adapter(默认 createPuppeteerAdapter,懒启动);注入便于测试。
	 * 供 POST /enable-rendering 运行时热启用,source 为本地路径或远程端点。
	 */
	createPuppeteer?: (source: ChromeSource) => StandalonePuppeteer;
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
	onPuppeteerEnabled?: (puppeteer: StandalonePuppeteer) => void;
}

const StyleSchema = z.object({
	cardColorStart: z.string(),
	cardColorEnd: z.string(),
	font: z.string().optional(),
	/** 主人自带字体的资产 id;设了优先于 `font`(预览与出图必须用同一款,否则「预览好看、推出去变样」)。 */
	fontAsset: z.string().optional(),
	showPopularity: z.boolean().optional(),
	showArea: z.boolean().optional(),
	showFans: z.boolean().optional(),
	glassOpacity: z.number().min(0).max(1).optional(),
	glassClear: z.boolean().optional(),
	/** 背景图资产 id 列表(空 = 渐变;>1 = 轮换,预览端取首张)。 */
	backgroundImages: z.array(z.string()).optional(),
	/** 直播封面资产 id 列表(空 = B 站封面;>1 = 轮换,预览端取首张)。仅 live 卡。 */
	liveCoverImages: z.array(z.string()).optional(),
});

const ContentSchema = z
	.object({
		// live: roomId triggers a real fetch via BilibiliAPI when present + non-empty.
		roomId: z.string().optional(),
		// dyn: uid + offset (1 = newest). offset defaults to 1 when only uid given.
		uid: z.string().optional(),
		offset: z.number().int().positive().optional(),
		// sc / guard: text override (sc body / guard new captain uname).
		text: z.string().optional(),
		// guard: 1 = 总督, 2 = 提督, 3 = 舰长. Drives both the captain badge
		// image and the bgColor — gradient style fields are ignored for guard.
		level: z.number().int().min(1).max(3).optional(),
		// sc: amount in CNY. Drives the SC tier (= bgColor + duration). Gradient
		// style fields are ignored for SC.
		price: z.number().int().min(1).optional(),
	})
	.optional();

const PreviewRequestSchema = z.object({
	kind: z.enum(["live", "dyn", "sc", "guard"]),
	style: StyleSchema,
	content: ContentSchema,
	/** 编辑器持有的整份版式草稿;renderPreviewCard 按 kind 取切片。缺省 = 默认版式。 */
	layout: CardLayoutSchema.optional(),
	/**
	 * 真实拉取失败时是否自动回退示例数据。per-UP 作用域自动用该 UP 真实数据预览,失败
	 * (未开播 / 无动态 / 网络)应静默回退;全局显式输入失败则照常报错告知用户。
	 */
	fallback: z.boolean().optional(),
});

const EnableRenderingSchema = z
	.object({
		chromePath: z.string().min(1).optional(),
		chromeEndpoint: z.string().min(1).optional(),
	})
	.refine((d) => d.chromePath || d.chromeEndpoint, {
		message: "chromePath 或 chromeEndpoint 至少填一项",
	});

type PreviewStyle = z.infer<typeof StyleSchema>;

// PreviewResponse / TestPushResponse 在 @bilibili-notify/contract(web 同源消费)。

type PreviewKind = z.infer<typeof PreviewRequestSchema>["kind"];
type PreviewContent = z.infer<typeof ContentSchema>;

const TestPushRequestSchema = z.object({
	targetId: z.uuid(),
	kind: z.enum(["live", "dyn", "sc", "guard"]),
	style: StyleSchema,
	content: ContentSchema,
	layout: CardLayoutSchema.optional(),
	fallback: z.boolean().optional(),
});

const RENDER_TIMEOUT_MS = 20_000;

/** 测试推送图说用的卡片类型中文标签。 */
const KIND_LABEL: Record<PreviewKind, string> = {
	live: "开播",
	dyn: "动态",
	sc: "醒目留言",
	guard: "上舰",
};

/**
 * 测试推送图片的图说(caption)。纯图片推送在 QQ 富媒体消息里会被塞一个占位空格(QQ 要求
 * content 非空),显示成图片下方一段空白;给测试推送配一句带类型标签的文案顶替它,接收方
 * 一眼能认出是测试,History 列表也不再落「(无内容)」。
 */
export function testPushCaption(kind: PreviewKind): string {
	return `【bilibili-notify 测试推送】${KIND_LABEL[kind]}卡片`;
}

/**
 * 收集当前配置里仍引用某背景图 id 的作用域(人话标签),用于删除前拦截。基准
 * `cardStyle.backgroundImages` 与**各卡片类型** `cardStyleByKind[*].backgroundImages`(per-kind)
 * 都算,全局默认 + 各 UP 覆盖两层都扫。返回空数组 = 没人用,可安全删盘。
 */
function cardBgReferences(globals: GlobalConfig, subs: Subscription[], id: string): string[] {
	// 背景图与直播封面共用同一图廊 —— 两类引用都算(删掉被封面引用的图同样会坏渲染)。
	const inStyle = (style?: { backgroundImages?: string[]; liveCoverImages?: string[] }): boolean =>
		(style?.backgroundImages?.includes(id) ?? false) ||
		(style?.liveCoverImages?.includes(id) ?? false);
	// per-kind 是各类型对基准的覆盖层;任一类型引用即算被引用。
	const inByKind = (
		byKind?: Record<string, { backgroundImages?: string[]; liveCoverImages?: string[] }>,
	): boolean => (byKind ? Object.values(byKind).some(inStyle) : false);

	const refs: string[] = [];
	if (inStyle(globals.defaults.cardStyle) || inByKind(globals.defaults.cardStyleByKind)) {
		refs.push("全局默认");
	}
	for (const s of subs) {
		if (inStyle(s.overrides.cardStyle) || inByKind(s.overrides.cardStyleByKind)) {
			refs.push(`UP ${s.uid}`);
		}
	}
	return refs;
}

/**
 * 哪些地方还选着这款字体 —— 与 {@link cardBgReferences} 同一套四层扫描
 * (全局基准 / 全局 per-kind / UP 基准 / UP per-kind)。**四层都得查**:漏掉哪一层,
 * 那一层的配置删完就成了悬空引用,出图静静落回兜底字体,而设置页还显示着它的名字。
 */
function fontAssetReferences(globals: GlobalConfig, subs: Subscription[], id: string): string[] {
	const inStyle = (style?: { fontAsset?: string }): boolean => style?.fontAsset === id;
	const inByKind = (byKind?: Record<string, { fontAsset?: string }>): boolean =>
		byKind ? Object.values(byKind).some(inStyle) : false;

	const refs: string[] = [];
	if (inStyle(globals.defaults.cardStyle) || inByKind(globals.defaults.cardStyleByKind)) {
		refs.push("全局默认");
	}
	for (const s of subs) {
		if (inStyle(s.overrides.cardStyle) || inByKind(s.overrides.cardStyleByKind)) {
			refs.push(`UP ${s.uid}`);
		}
	}
	return refs;
}

export function createCardsRoute(opts: CardsRouteOptions): Hono {
	const app = new Hono();
	const log = opts.deps.runtime.serviceCtx.logger;

	// 自动探测本机 Chrome —— dashboard「自动探测」按钮。未配 chromePath 时一键找到
	// 本地浏览器,免手填路径;探测不到返回 { path: null }。
	const detectChrome = opts.detectChrome ?? (() => resolveChromePath(undefined));
	app.get("/detect-chrome", (c) => c.json({ path: detectChrome() }));

	// 当前 puppeteer adapter —— 可变 holder。启动时 = currentPuppeteer(可能 null);经
	// /enable-rendering 运行时热启用/热切换后指向新 adapter,使后续 /preview 也用上,
	// 无需重启。currentSource 与之同步,供 /render-source 展示与同源幂等判断。
	let currentPuppeteer = opts.puppeteer;
	let currentSource: ChromeSource | null = opts.initialChromeSource ?? null;

	const sourceEquals = (a: ChromeSource | null, b: ChromeSource): boolean =>
		!!a && a.chromePath === b.chromePath && a.chromeEndpoint === b.chromeEndpoint;

	// 当前渲染浏览器来源 —— System 页「卡片渲染浏览器」区的数据源。persistable=false
	// 表示无可写 bootstrap 配置(legacy / desktop),切换仍生效但重启不保留。
	app.get("/render-source", (c) =>
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
	// 调用:运行时构造 puppeteer、注入已跑的 live/dynamic 引擎、写回浏览器来源持久化,
	// 全程不重启。已启用时:同源 → alreadyEnabled 幂等;异源 → 先探测新浏览器,通了
	// 才 swap 并 dispose 旧 adapter(别把能用的配置换成坏的)。
	app.post("/enable-rendering", async (c) => {
		const body = await c.req.json().catch(() => null);
		const parsed = EnableRenderingSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ ok: false, err: "chromePath 或 chromeEndpoint 至少填一项" }, 400);
		}
		const engines = opts.deps.runtime.engines;
		if (!engines) return c.json({ ok: false, err: "engines 未就绪" }, 503);
		const source = parsed.data;
		// 热切换 = 路由已握有在用 adapter;同源直接幂等返回,连 adapter 都不构造。
		const replacing = currentPuppeteer !== null;
		if (replacing && sourceEquals(currentSource, source)) {
			return c.json({ ok: true, alreadyEnabled: true });
		}
		try {
			const pup = createPuppeteer(source);
			// 连通性探测:远程端点没有 detect-chrome 那样的存在性预验,连不上只会在
			// 之后首次渲染才暴露;热切换则无论来源都要先验 —— 失败就不动现有渲染器。
			if (source.chromeEndpoint || replacing) {
				try {
					const probe = await pup.page();
					await probe.close();
				} catch (err) {
					await pup.dispose();
					const detail = err instanceof Error ? err.message : String(err);
					log.warn(`[cards] 浏览器探测失败 · ${JSON.stringify(source)}: ${detail}`);
					return c.json({ ok: false, err: `浏览器连接失败：${detail}` }, 502);
				}
			}
			if (replacing) {
				engines.swapImageRendering(pup);
			} else {
				const enabled = engines.enableImageRendering(pup);
				if (!enabled) {
					// 引擎侧已有渲染器但路由不知情(理论不该发生的接线错位):保持旧行为,
					// 释放多余 adapter。
					await pup.dispose();
					return c.json({ ok: true, alreadyEnabled: true });
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
				log.error(`[cards] 浏览器来源持久化失败(切换已生效,旧浏览器未销毁) · ${detail}`);
				return c.json(
					{ ok: false, err: `切换已生效,但配置写入失败(重启会退回旧来源)：${detail}` },
					500,
				);
			}
			if (old) {
				// 旧浏览器关掉(本地)/断开(远程)。若旧 adapter 恰有渲染在飞,那一张会
				// 失败一次 —— 切换是人工低频操作,可接受。
				await old.dispose();
			}
			log.info(
				`[cards] 卡片渲染已${replacing ? "热切换" : "热启用"} · ${
					source.chromeEndpoint
						? `chromeEndpoint=${source.chromeEndpoint}`
						: `chromePath=${source.chromePath}`
				}`,
			);
			return c.json({ ok: true, ...source });
		} catch (err) {
			const detail = String((err as Error)?.message ?? err);
			log.error(`[cards] enable-rendering failed: ${detail}`);
			return c.json({ ok: false, err: detail }, 500);
		}
	});

	// 背景图上传 → 落盘 `<dataDir>/assets/card-bg/<id>`,返回资产 id 写进 cardStyle.backgroundImage。
	app.post("/asset", async (c) => {
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) return c.json({ ok: false, err: "缺少图片文件" }, 400);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const id = await saveCardBg(opts.deps.store.bootstrap.dataDir, bytes, file.type);
			return c.json({ ok: true, id });
		} catch (err) {
			return c.json({ ok: false, err: String((err as Error)?.message ?? err) }, 400);
		}
	});

	// 图廊列表 —— 列出已上传的所有背景图 id,供前端图廊选择。
	app.get("/assets", async (c) => {
		const ids = await listCardBg(opts.deps.store.bootstrap.dataDir);
		return c.json({ ok: true, ids });
	});

	// 背景图服务 —— 经 id 正则校验的定向读取(绝不 serveStatic 整个 dataDir,内有 secrets)。
	app.get("/asset/:id", async (c) => {
		const res = await readCardBg(opts.deps.store.bootstrap.dataDir, c.req.param("id"));
		if (!res) return c.json({ ok: false, err: "not found" }, 404);
		return new Response(res.bytes, {
			headers: {
				"Content-Type": res.mime,
				"Cache-Control": "private, max-age=31536000, immutable",
			},
		});
	});

	// 图廊删除 —— 仍被全局 / 某 UP 引用的图先拦截(409),避免删掉正在用的背景图。
	app.delete("/asset/:id", async (c) => {
		const id = c.req.param("id");
		if (!isValidCardBgId(id)) return c.json({ ok: false, err: "无效的资产 id" }, 400);
		const referencedBy = cardBgReferences(
			opts.deps.store.getGlobals(),
			opts.deps.store.getSubscriptions(),
			id,
		);
		if (referencedBy.length > 0) {
			return c.json(
				{ ok: false, err: "该背景图仍被使用,请先在卡片设置里移除再删除", referencedBy },
				409,
			);
		}
		const removed = await deleteCardBg(opts.deps.store.bootstrap.dataDir, id);
		return c.json({ ok: removed });
	});

	// ---- 字体图廊 -----------------------------------------------------------
	//
	// 与上面背景图那四个端点同形(落盘 + id 引用 + 定向读取 + 删除前查引用)。字体单独
	// 一套目录与一套端点,不与背景图混:两者的合法后缀、体积上限、以及「列表里显示什么」
	// 都不一样(字体没有缩略图可看,列表得带原始文件名)。

	// 字体上传 → 落盘 `<dataDir>/assets/font/<id>`,返回资产 id 写进 cardStyle.fontAsset。
	// 后缀取自**原始文件名**而不是 mime —— 浏览器给字体的 mime 一塌糊涂(同一个 .ttf 可能
	// 是 font/ttf、application/x-font-ttf、application/octet-stream 甚至空串)。
	app.post("/font-asset", async (c) => {
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) return c.json({ ok: false, err: "缺少字体文件" }, 400);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const id = await saveFontAsset(opts.deps.store.bootstrap.dataDir, bytes, file.name);
			return c.json({ ok: true, id, name: file.name });
		} catch (err) {
			return c.json({ ok: false, err: String((err as Error)?.message ?? err) }, 400);
		}
	});

	// 字体图廊列表 —— 带原始文件名,否则设置页上只剩一串 hex,主人认不出哪个是哪个。
	app.get("/font-assets", async (c) => {
		const fonts = await listFontAssets(opts.deps.store.bootstrap.dataDir);
		return c.json({ ok: true, fonts });
	});

	// 字体文件服务 —— 经 id 正则校验的定向读取(绝不 serveStatic 整个 dataDir,内有 secrets)。
	// 设置页拿它做预览:同一款字体在页面上和出图里得是同一款。
	app.get("/font-asset/:id", async (c) => {
		const res = await readFontAsset(opts.deps.store.bootstrap.dataDir, c.req.param("id"));
		if (!res) return c.json({ ok: false, err: "not found" }, 404);
		return new Response(res.bytes, {
			headers: {
				"Content-Type": res.mime,
				"Cache-Control": "private, max-age=31536000, immutable",
			},
		});
	});

	// 字体删除 —— 仍被某处选着的先拦截(409)。直接删掉的话那一处立刻成了悬空引用:
	// 出图静静回落到兜底字体,而设置页上还显示着这款字体的名字,主人查都没法查。
	app.delete("/font-asset/:id", async (c) => {
		const id = c.req.param("id");
		if (!isValidFontAssetId(id)) return c.json({ ok: false, err: "无效的资产 id" }, 400);
		const referencedBy = fontAssetReferences(
			opts.deps.store.getGlobals(),
			opts.deps.store.getSubscriptions(),
			id,
		);
		if (referencedBy.length > 0) {
			return c.json(
				{ ok: false, err: "该字体仍被使用,请先在卡片设置里换掉再删除", referencedBy },
				409,
			);
		}
		const removed = await deleteFontAsset(opts.deps.store.bootstrap.dataDir, id);
		return c.json({ ok: removed });
	});

	// One ImageRenderer reused across requests. Lazy — only constructed when
	// the first real-fetch / sc / guard path actually runs, so deployments
	// without BN_CHROME_PATH don't spin one up needlessly.
	//
	// 每次请求都 updateConfig 一遍传入的 style — 否则用户在 Cards 页改完颜色后
	// 第一次 /preview 构造一个 renderer 后,后续改色就不生效(renderer 是 lazy 单例)。
	// `@font-face` 规则的读取口 —— **本路由只此一份**,mock 路径(live / dyn 走示例数据)
	// 与 ImageRenderer 都走它。一款中文字库 base64 后二三十兆,而镜像里 V8 堆上限只有
	// 384MB;各读各的话,一屏几张卡就能把堆顶起来。共用之后两边拿到的是同一个字符串
	// 引用,内存里始终只有一份。
	//
	// 缓存里留的是**拼好的规则**而不是 data URL:规则本身就把 data URL 包在里头,存前者
	// 就等于让后者可被回收,同一串东西不必占两份。
	//
	// 惰性构造:`/enable-rendering`、`/detect-chrome` 这些路由不碰 store,它们的测试
	// 给的也是不带 store 的最小 deps —— 在这儿直接取 `bootstrap.dataDir` 会让整条路由
	// 建不起来。真要读字体时再取,那条路径上 store 必然在。
	let fontReader: ((id: string) => Promise<string>) | null = null;
	const loadFontFace = (id: string): Promise<string> => {
		if (!id) return Promise.resolve("");
		fontReader ??= createFontAssetReader(opts.deps.store.bootstrap.dataDir, {
			transform: buildFontFace,
		});
		return fontReader(id);
	};

	let imageRenderer: ImageRenderer | null = null;
	// 缓存绑定的 adapter 快照 —— 热切换(/enable-rendering)会把 currentPuppeteer 换成
	// 新 adapter 并 dispose 旧的,若不比对直接复用,imageRenderer 会一直攥着已销毁的
	// 旧 adapter(ImageRenderer.puppeteer 是 readonly,updateConfig 换不了它)。
	let imageRendererPuppeteer: StandalonePuppeteer | null = null;
	async function getImageRenderer(style: PreviewStyle): Promise<ImageRenderer | null> {
		if (!currentPuppeteer) return null;
		const config = {
			cardColorStart: style.cardColorStart,
			cardColorEnd: style.cardColorEnd,
			font: style.font ?? "PingFang SC, sans-serif",
			showPopularity: style.showPopularity ?? true,
			showArea: style.showArea ?? true,
			showFans: style.showFans ?? true,
			glassOpacity: style.glassOpacity,
			glassClear: style.glassClear,
			// 跳过悬空引用(文件已删的 id),取第一张盘上存在的图 —— 否则解析失败静默回退渐变。
			backgroundImage: await firstExistingCardBg(
				opts.deps.store.bootstrap.dataDir,
				style.backgroundImages,
			),
			// 预览得跟出图用同一款字体,否则「预览好看、推出去变样」。悬空 id 由
			// resolveFontFace 兜成空串,渲染器据此回落家族名。
			fontAsset: style.fontAsset,
		};
		if (!imageRenderer || imageRendererPuppeteer !== currentPuppeteer) {
			imageRenderer = new ImageRenderer({
				serviceCtx: opts.deps.runtime.serviceCtx,
				puppeteer: currentPuppeteer,
				config,
				// 背景图 id → data URL(读 <dataDir>/assets/card-bg);sc/guard/真实拉取走 generate* 解析。
				resolveAsset: (id) => readCardBgDataUrl(opts.deps.store.bootstrap.dataDir, id),
				// 字体 id → 拼好的 @font-face(读 <dataDir>/assets/font)。
				resolveFontFace: loadFontFace,
				// 预览:每来一次请求就热更一次样式,打 info 会刷屏且像"已保存"。真正生效的
				// INFO 由推送渲染器(runtime/engines.ts)在 config-changed 后打。
				quietConfigUpdates: true,
			});
			imageRendererPuppeteer = currentPuppeteer;
		} else {
			imageRenderer.updateConfig(config);
		}
		return imageRenderer;
	}

	// Cached snapshot of the logged-in B站 account. Used as the SENDER on
	// SC / Guard preview cards (the SC payer / new captain), not the
	// receiver — the receiver is the subscribed UP, which on preview stays
	// as "示例 UP 主". Refreshes every 5 minutes; returns null when the
	// account isn't logged in or the call fails.
	const LOGGED_IN_TTL_MS = 5 * 60 * 1000;
	let loggedInCache: { name: string; avatar: string; ts: number } | null = null;
	async function getLoggedInAccount(): Promise<{ name: string; avatar: string } | null> {
		const now = Date.now();
		if (loggedInCache && now - loggedInCache.ts < LOGGED_IN_TTL_MS) {
			return { name: loggedInCache.name, avatar: loggedInCache.avatar };
		}
		if (opts.api) {
			try {
				// /x/member/web/account returns only mid + uname; face requires the
				// /x/web-interface/card endpoint (same two-step the LoginFlow does
				// in reportAccountInfo). Skipping the second call left avatars
				// undefined and the preview fell through to the SVG placeholder.
				// 走客户端共享的账号身份缓存(与直播建连同一份;换号/登出自动失效)。
				const my = await opts.api.getMyselfInfoCached();
				if (my?.code === 0 && my.data?.mid) {
					const card = await opts.api.getUserCardInfo(String(my.data.mid));
					if (card?.code === 0 && card.data?.card?.face) {
						const name = card.data.card.name || my.data.uname;
						const avatar = card.data.card.face;
						loggedInCache = { name, avatar, ts: now };
						return { name, avatar };
					}
				}
			} catch (err) {
				log.warn(`[cards] resolve logged-in account failed: ${(err as Error).message}`);
			}
		}
		// 解析失败 / 未就绪:若曾成功解析过,沿用历史快照(stale-while-error),不让一次
		// 瞬时失败把 SC / 上舰发送者闪回「示例粉丝」。仅从未成功过才回退示例。
		if (loggedInCache) {
			return { name: loggedInCache.name, avatar: loggedInCache.avatar };
		}
		return null;
	}

	// SC / 上舰卡接收方(被 SC / 被上舰的 UP)。per-UP 预览传 content.uid → 实时拉真实
	// 名字 / 头像;全局无 uid、或解析失败且 fallback → 退回示例 UP。
	async function resolvePreviewMaster(
		content: PreviewContent,
		fallback: boolean,
	): Promise<{ name: string; face: string }> {
		const uid = content?.uid?.trim();
		if (uid && opts.api) {
			try {
				return await resolveMasterInfo(opts.api, uid);
			} catch (err) {
				if (!fallback) throw err;
				log.info(`[cards] SC / 上舰接收方解析失败,回退示例:${(err as Error).message}`);
			}
		}
		return { name: "示例 UP 主", face: SVG_AVATAR_BLUE };
	}

	// 渲染一张样例卡片 → JPEG / PNG Buffer。/preview 与 /test-push 共用。失败抛 Error
	// (消息直接面向用户)。SC / Guard 走 ImageRenderer;live / dyn 有 content 走真实
	// 拉取,否则虚构 mock 数据。调用方须先确认 currentPuppeteer 存在。
	async function renderPreviewCard(
		kind: PreviewKind,
		style: PreviewStyle,
		content: PreviewContent,
		layout?: CardLayout,
		fallback = false,
	): Promise<{ buffer: Buffer; mime: string }> {
		const puppeteer = currentPuppeteer;
		if (!puppeteer) throw new Error("puppeteer 未就绪");

		if (kind === "sc") {
			const renderer = await getImageRenderer(style);
			if (!renderer) throw new Error("puppeteer 未就绪");
			// 登录账号 = SC 发送者(「我在别人直播间发条 SC 会长啥样」);接收方 = 该 UP。
			const me = await getLoggedInAccount();
			const master = await resolvePreviewMaster(content, fallback);
			const buffer = await renderer.generateSCCard(
				{
					senderFace: me?.avatar ?? SVG_AVATAR_FAN,
					senderName: me?.name ?? "示例粉丝",
					masterName: master.name,
					masterAvatarUrl: master.face,
					text: content?.text?.trim() || "主播加油！这首要听到！示例 UP 主唱得太好了！",
					price: content?.price ?? 30,
				},
				// 预览样式已由 getImageRenderer(style) 烤进渲染器 config,故 colorOptions 留空。
				{},
				layout?.sc,
			);
			return { buffer, mime: "image/jpeg" };
		}
		if (kind === "guard") {
			const renderer = await getImageRenderer(style);
			if (!renderer) throw new Error("puppeteer 未就绪");
			// 登录账号 = 新舰长(触发上舰事件的人);显式 text 覆写仍优先。接收方 = 该 UP。
			const me = await getLoggedInAccount();
			const uname = content?.text?.trim() || me?.name || "示例新舰长";
			const face = me?.avatar ?? SVG_AVATAR_PINK;
			const master = await resolvePreviewMaster(content, fallback);
			const buffer = await renderer.generateGuardCard(
				{ guardLevel: (content?.level ?? 3) as 1 | 2 | 3, uname, face, isAdmin: 0 },
				{ masterAvatarUrl: master.face, masterName: master.name },
				// 预览样式已由 getImageRenderer(style) 烤进渲染器 config,故 colorOptions 留空。
				{},
				layout?.guard,
			);
			return { buffer, mime: "image/jpeg" };
		}
		// Live + Dyn:有 roomId / uid 走真实拉取。live 优先用显式 roomId,否则按 uid 解析
		// 房间号(per-UP 自动模式只持有 uid)。fallback=true 时真实拉取失败回退示例数据;
		// 否则(全局显式输入)把错误原样抛出告知用户。
		if (kind === "live" && (content?.roomId?.trim() || content?.uid?.trim())) {
			try {
				const renderer = await getImageRenderer(style);
				if (!renderer) throw new Error("puppeteer 未就绪");
				if (!opts.api) throw new Error("auth system 未就绪 — 后端账号尚未登录");
				const roomId =
					content.roomId?.trim() ||
					(await resolveRoomIdFromUid(opts.api, content.uid?.trim() ?? ""));
				const buffer = await renderRealLive(
					opts.api,
					renderer,
					roomId,
					style,
					opts.deps.store.bootstrap.dataDir,
					layout?.live,
				);
				return { buffer, mime: "image/jpeg" };
			} catch (err) {
				if (!fallback) throw err;
				log.info(`[cards] live 真实渲染失败,回退示例数据:${(err as Error).message}`);
			}
		}
		if (kind === "dyn" && content?.uid?.trim()) {
			try {
				const renderer = await getImageRenderer(style);
				if (!renderer) throw new Error("puppeteer 未就绪");
				if (!opts.api) throw new Error("auth system 未就绪 — 后端账号尚未登录");
				const buffer = await renderRealDynamic(
					opts.api,
					renderer,
					content.uid.trim(),
					content.offset ?? 1,
					style,
					layout?.dynamic,
				);
				return { buffer, mime: "image/jpeg" };
			} catch (err) {
				if (!fallback) throw err;
				log.info(`[cards] dyn 真实渲染失败,回退示例数据:${(err as Error).message}`);
			}
		}
		// Live + Dyn 无真实数据(或回退):虚构 mock 数据,走 renderCard + screenshot 流水线
		// (不经 ImageRenderer,未登录也能调色)。背景图/直播封面在此解析成 data URL 注入;
		// 取「第一张盘上存在的图」,跳过悬空引用。
		const dataDir = opts.deps.store.bootstrap.dataDir;
		// 背景图、直播封面、自带字体互不依赖(各自独立的资产解析),并发发起省几次串行 I/O。
		const [bgDataUrl, coverDataUrl, fontFace] = await Promise.all([
			firstExistingCardBg(dataDir, style.backgroundImages).then((id) =>
				readCardBgDataUrl(dataDir, id),
			),
			kind === "live"
				? firstExistingCardBg(dataDir, style.liveCoverImages).then((id) =>
						readCardBgDataUrl(dataDir, id),
					)
				: Promise.resolve(""),
			loadFontFace(style.fontAsset ?? ""),
		]);
		const { component, props, title, htmlWidth } = buildPreviewSpec(
			kind,
			style,
			layout,
			bgDataUrl,
			coverDataUrl,
		);
		// 自带字体优先于家族名(与 ImageRenderer#resolveFont 同一套判断);资产悬空时
		// fontFace 是空串,静静回落家族名。
		const html = await renderCard(component, props, {
			title,
			font: fontFace ? USER_FONT_FAMILY : (style.font ?? "PingFang SC, sans-serif"),
			fontFace: fontFace || undefined,
			htmlWidth,
		});
		const buffer = await screenshotHtml(puppeteer, html);
		return { buffer, mime: "image/png" };
	}

	app.post("/preview", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = PreviewRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json<PreviewResponse>({ ok: false, err: "invalid_request" }, 400);
		}
		if (!currentPuppeteer) {
			return c.json<PreviewResponse>(
				{
					ok: false,
					err: "puppeteer 未配置 — 设置 BN_CHROME_PATH（本地 Chromium 路径）或 BN_CHROME_ENDPOINT（远程浏览器端点），或 yaml 的 chromePath / chromeEndpoint 字段",
				},
				503,
			);
		}
		const { kind, style, content, layout, fallback } = parsed.data;
		try {
			const { buffer, mime } = await renderPreviewCard(kind, style, content, layout, fallback);
			return c.json<PreviewResponse>({
				ok: true,
				dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`[cards] preview render failed (${kind}): ${msg}`);
			return c.json<PreviewResponse>({ ok: false, err: msg }, 500);
		}
	});

	// POST /api/cards/test-push — 渲染当前预览卡片(同 /preview 的草稿样式)并真实
	// 推送给一个 PushTarget。图片 Tab「测试推送」用,所见即所推。
	app.post("/test-push", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = TestPushRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json<TestPushResponse>({ ok: false, latencyMs: 0, err: "invalid_request" }, 400);
		}
		const { targetId, kind, style, content, layout, fallback } = parsed.data;

		if (!currentPuppeteer) {
			return c.json<TestPushResponse>(
				{ ok: false, latencyMs: 0, err: "puppeteer 未配置,无法渲染卡片" },
				503,
			);
		}
		const engines = opts.deps.runtime.engines;
		if (!engines) {
			return c.json<TestPushResponse>(
				{ ok: false, latencyMs: 0, err: "engines not yet attached" },
				503,
			);
		}
		const target = opts.deps.store.getTargets().find((t) => t.id === targetId);
		if (!target) {
			return c.json<TestPushResponse>({ ok: false, latencyMs: 0, err: "target not found" }, 404);
		}

		let card: { buffer: Buffer; mime: string };
		try {
			card = await renderPreviewCard(kind, style, content, layout, fallback);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`[cards] test-push render failed (${kind}): ${msg}`);
			return c.json<TestPushResponse>({ ok: false, latencyMs: 0, err: `卡片渲染失败:${msg}` }, 500);
		}

		const payload: NotificationPayload = {
			kind: "image",
			image: { buffer: card.buffer, mime: card.mime },
			// 配一句图说,顶替纯图片在 QQ 富媒体消息里的占位空格(否则图片下方一段空白)。
			caption: testPushCaption(kind),
		};
		const result = await engines.push.sendToTarget(target.id, payload);
		return c.json<TestPushResponse>(result);
	});

	return app;
}

// ── Real-fetch renderers ─────────────────────────────────────────────────────

interface BilibiliEnvelope<T> {
	code: number;
	message?: string;
	msg?: string;
	data?: T;
}

/**
 * uid → 真实 UP 名字 + 头像。SC / 上舰预览的**接收方**(被 SC / 被上舰的 UP):
 * per-UP 预览传该 UP 的 uid,后端实时拉真实资料,免依赖 dashboard 端可能缺失的
 * cachedProfile。走 getMasterInfo(与 live 真实渲染同一接口),失败抛 Error。
 */
async function resolveMasterInfo(
	api: BilibiliAPI,
	uid: string,
): Promise<{ name: string; face: string }> {
	if (!/^\d+$/.test(uid)) throw new Error("UID 必须是纯数字");
	const master = (await api.getMasterInfo(uid)) as BilibiliEnvelope<{
		info: { uname: string; face: string };
	}>;
	if (master.code !== 0 || !master.data?.info) {
		throw new Error(`getMasterInfo 失败：${master.message ?? master.msg ?? `code=${master.code}`}`);
	}
	return { name: master.data.info.uname, face: master.data.info.face };
}

/**
 * uid → 直播间号。走 `getUserInfo(uid).data.live_room.roomid`(与 live 引擎
 * listener 解析房间号同一路径)。per-UP 自动预览只持有 uid,live 真实拉取前先解析。
 * 未开通直播间 / 解析失败抛 Error。
 */
export async function resolveRoomIdFromUid(api: BilibiliAPI, uid: string): Promise<string> {
	if (!/^\d+$/.test(uid)) throw new Error("UID 必须是纯数字");
	const info = (await api.getUserInfo(uid)) as BilibiliEnvelope<{
		live_room?: { roomid?: number };
	}>;
	const roomid = info?.data?.live_room?.roomid;
	const n = Number(roomid);
	if (!Number.isFinite(n) || n <= 0) throw new Error("该 UP 未开通直播间或无法解析房间号");
	return String(n);
}

async function renderRealLive(
	api: BilibiliAPI,
	renderer: ImageRenderer,
	roomId: string,
	style: PreviewStyle,
	dataDir: string,
	layout?: CardBlock[],
): Promise<Buffer> {
	if (!/^\d+$/.test(roomId)) throw new Error("直播间号必须是纯数字");

	const room = (await api.getLiveRoomInfo(roomId)) as BilibiliEnvelope<{
		uid: number;
		live_status: number;
		short_id?: number;
		room_id?: number;
		[k: string]: unknown;
	}>;
	if (room.code !== 0 || !room.data) {
		throw new Error(`getLiveRoomInfo 失败：${room.message ?? room.msg ?? `code=${room.code}`}`);
	}
	const uid = String(room.data.uid);
	if (!uid || uid === "0") throw new Error("直播间 uid 缺失，可能是无效房间号");

	const master = (await api.getMasterInfo(uid)) as BilibiliEnvelope<{
		info: { uname: string; face: string };
		[k: string]: unknown;
	}>;
	if (master.code !== 0 || !master.data) {
		throw new Error(`getMasterInfo 失败：${master.message ?? master.msg ?? `code=${master.code}`}`);
	}

	// liveStatus 2 (LiveBroadcast) — render the "正在直播" badge regardless of
	// real status, so a closed room still renders something visible. The
	// renderer normalises liveStatus internally; using 2 = LiveBroadcast keeps
	// us aligned with what the periodic ongoing-tick passes in production.
	return renderer.generateLiveCard(
		room.data,
		master.data.info.uname,
		master.data.info.face,
		{}, // liveData — no danmaku context in preview, watched/liked left blank
		2,
		{
			cardColorStart: style.cardColorStart,
			cardColorEnd: style.cardColorEnd,
			// 自定义直播封面:跳过悬空引用(文件已删的 id),取第一张盘上存在的图 ——
			// 与 mock 预览 / 生产推送同一条守卫,否则第一张是幽灵 id 时会静默回退
			// B 站原始封面,即便后面还有张有效图。
			liveCoverImage: await firstExistingCardBg(dataDir, style.liveCoverImages),
		},
		layout,
	);
}

async function renderRealDynamic(
	api: BilibiliAPI,
	renderer: ImageRenderer,
	uid: string,
	offset: number,
	style: PreviewStyle,
	layout?: CardBlock[],
): Promise<Buffer> {
	if (!/^\d+$/.test(uid)) throw new Error("UID 必须是纯数字");

	const feed = (await api.getUserSpaceDynamic(uid)) as BilibiliEnvelope<{
		// biome-ignore lint/suspicious/noExplicitAny: Bilibili 动态接口返回原样透传给渲染器
		items?: any[];
	}>;
	if (feed.code !== 0 || !feed.data) {
		throw new Error(`getUserSpaceDynamic 失败：${feed.message ?? feed.msg ?? `code=${feed.code}`}`);
	}
	const items = Array.isArray(feed.data.items) ? feed.data.items : [];
	if (items.length === 0) throw new Error("该 UP 主暂无动态");
	const idx = offset - 1; // offset is 1-based
	if (idx >= items.length) {
		throw new Error(`动态序号 ${offset} 超出范围（仅有 ${items.length} 条）`);
	}
	const item = items[idx];
	if (!item) throw new Error(`第 ${offset} 条动态为空`);

	return renderer.generateDynamicCard(
		item,
		{
			cardColorStart: style.cardColorStart,
			cardColorEnd: style.cardColorEnd,
		},
		layout,
	);
}

// ── Mock pipeline (fall-through path) ────────────────────────────────────────

interface PreviewSpec {
	component: Component;
	props: Record<string, unknown>;
	title: string;
	htmlWidth: number;
}

function buildPreviewSpec(
	kind: "live" | "dyn",
	style: PreviewStyle,
	layout?: CardLayout,
	/** 已解析的背景图 data URL(mock SSR 路径不经 generate*,需在此注入)。 */
	bgDataUrl?: string,
	/** 已解析的直播封面 data URL(仅 live 卡消费,语义同上)。 */
	coverDataUrl?: string,
): PreviewSpec {
	const backgroundImage = bgDataUrl || undefined;
	if (kind === "live") {
		return {
			component: LiveCard,
			props: {
				...buildLivePreviewProps(style),
				layout: layout?.live,
				backgroundImage,
				coverOverride: coverDataUrl || undefined,
			},
			title: "卡片预览 · 直播",
			htmlWidth: 600,
		};
	}
	return {
		component: DynamicCard,
		props: { ...buildDynamicPreviewProps(style), layout: layout?.dynamic, backgroundImage },
		title: "卡片预览 · 动态",
		htmlWidth: 600,
	};
}

const SVG_COVER =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 338'%3E%3Crect width='600' height='338' fill='%23FB7299'/%3E%3Ctext x='50%25' y='50%25' fill='white' font-size='32' text-anchor='middle' dominant-baseline='middle'%3ECover%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_PINK =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23FB7299'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='28' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_BLUE =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%2300AEEC'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='30' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_FAN =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23fdcb6e'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='28' text-anchor='middle' dominant-baseline='middle'%3E粉%3C/text%3E%3C/svg%3E";

function buildLivePreviewProps(style: PreviewStyle): LiveCardProps {
	return {
		showPopularity: style.showPopularity ?? true,
		showArea: style.showArea ?? true,
		showFans: style.showFans ?? true,
		cardColorStart: style.cardColorStart,
		cardColorEnd: style.cardColorEnd,
		glassOpacity: style.glassOpacity,
		glassClear: style.glassClear,
		data: {
			user_cover: SVG_COVER,
			keyframe: "",
			title: "【赛博朋克 2077】资料片实况首播！",
			area_name: "游戏",
			description: "今晚 7 点开始，欢迎围观。这是一段示例直播间简介。",
			online: 12_345,
		},
		username: "示例 UP 主",
		userface: SVG_AVATAR_BLUE,
		titleStatus: "已开播 12 分钟",
		liveTime: "2026-05-09 19:00:00",
		liveStatus: 1,
		cover: true,
		onlineNum: "1.2万",
		likedNum: "8.7万",
		watchedNum: "3.4万",
		fansNum: "215万",
		fansChanged: "+128",
	};
}

function buildDynamicPreviewProps(style: PreviewStyle): DynamicCardProps {
	const body = h(
		"div",
		{
			style: "font-size:14px;line-height:1.7;color:#444;white-space:pre-line;",
		},
		"这是一段示例动态正文。你可以在「卡片预览·样式」里看到改色后的渲染效果。\n第二行用来演示换行和留白。",
	);
	// 附加内容块的示例(预约样式),让用户在预览里看到 additional 块独立排版的位置。
	const additional = h(
		"div",
		{ style: "background:rgba(0,0,0,0.04);border-radius:8px;padding:10px;" },
		[
			h(
				"div",
				{ style: "font-size:14px;font-weight:bold;color:#18191C;" },
				"示例预约 · 新版本直播",
			),
			h(
				"div",
				{ style: "font-size:12px;color:#999;margin-top:4px;" },
				"6月30日 20:00 · 1.2万人预约",
			),
		],
	);
	// 转发示例:内部原动态用同一套版式递归渲染,标签贴在内部作者名后。
	const forward = {
		avatarUrl: SVG_AVATAR_PINK,
		upName: "被转发的 UP 主",
		upIsVip: false,
		pubTime: "2026-05-08 10:30:00",
		headerLabel: "投稿了视频",
		topic: undefined,
		body: h(
			"div",
			{ style: "font-size:14px;line-height:1.7;color:#444;" },
			"这是被转发的原动态正文 —— 内部也跟随同一套版式（块顺序 / 显隐 / 边距）。",
		),
		additional: null,
		stats: undefined,
	};
	return {
		cardColorStart: style.cardColorStart,
		cardColorEnd: style.cardColorEnd,
		glassOpacity: style.glassOpacity,
		glassClear: style.glassClear,
		node: {
			avatarUrl: SVG_AVATAR_BLUE,
			upName: "示例 UP 主",
			upIsVip: true,
			pubTime: "2026-05-09 18:24:00",
			topic: "示例话题",
			body,
			additional,
			forward,
			stats: { forward: "1.2万", comment: "5,891", like: "8.7万" },
		},
	};
}

async function screenshotHtml(pup: StandalonePuppeteer, html: string): Promise<Buffer> {
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
