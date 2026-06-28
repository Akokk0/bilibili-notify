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
import {
	type Component,
	DynamicCard,
	type DynamicCardProps,
	h,
	ImageRenderer,
	LiveCard,
	type LiveCardProps,
	renderCard,
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
import {
	deleteCardBg,
	isValidCardBgId,
	listCardBg,
	readCardBg,
	readCardBgDataUrl,
	saveCardBg,
} from "../runtime/card-assets.js";
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
	 * 供 POST /enable-rendering 运行时热启用。
	 */
	createPuppeteer?: (chromePath: string) => StandalonePuppeteer;
	/**
	 * 把 chromePath 写回 bootstrap yaml 持久化。由 index.ts 接线(绑定 config 路径);
	 * 未注入则热启用仍生效但重启不保留。
	 */
	persistChromePath?: (chromePath: string) => Promise<void>;
	/**
	 * 热启用成功后回调,通知 index.ts 更新全局 puppeteer 引用(供进程退出时 dispose)。
	 */
	onPuppeteerEnabled?: (puppeteer: StandalonePuppeteer) => void;
}

const StyleSchema = z.object({
	cardColorStart: z.string(),
	cardColorEnd: z.string(),
	font: z.string().optional(),
	hideDesc: z.boolean().optional(),
	hideFollower: z.boolean().optional(),
	glassOpacity: z.number().min(0).max(1).optional(),
	glassClear: z.boolean().optional(),
	/** 背景图资产 id 列表(空 = 渐变;>1 = 轮换,预览端取首张)。 */
	backgroundImages: z.array(z.string()).optional(),
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

const EnableRenderingSchema = z.object({ chromePath: z.string().min(1) });

type PreviewStyle = z.infer<typeof StyleSchema>;

export interface PreviewResponse {
	ok: boolean;
	dataUrl?: string;
	err?: string;
}

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

/** /api/cards/test-push 响应 —— 与 push.ts 的 TestResponse 同形。 */
export interface TestPushResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

const RENDER_TIMEOUT_MS = 20_000;

/**
 * 收集当前配置里仍引用某背景图 id 的作用域(人话标签),用于删除前拦截。基准
 * `cardStyle.backgroundImages` 与**各卡片类型** `cardStyleByKind[*].backgroundImages`(per-kind)
 * 都算,全局默认 + 各 UP 覆盖两层都扫。返回空数组 = 没人用,可安全删盘。
 */
export function cardBgReferences(
	globals: GlobalConfig,
	subs: Subscription[],
	id: string,
): string[] {
	const inStyle = (style?: { backgroundImages?: string[] }): boolean =>
		style?.backgroundImages?.includes(id) ?? false;
	// per-kind 是各类型对基准的覆盖层;任一类型引用即算被引用。
	const inByKind = (byKind?: Record<string, { backgroundImages?: string[] }>): boolean =>
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
	// /enable-rendering 运行时热启用后指向新 adapter,使后续 /preview 也用上,无需重启。
	let currentPuppeteer = opts.puppeteer;
	const createPuppeteer =
		opts.createPuppeteer ??
		((chromePath: string) => createPuppeteerAdapter({ chromePath, logger: log }));

	// 一键热启用卡片渲染 —— dashboard 探测到 Chrome 后调用:运行时构造 puppeteer、
	// 注入已跑的 live/dynamic 引擎(EnginesRuntime.enableImageRendering)、写回 chromePath
	// 持久化,全程不重启。已启用则 dispose 多余 adapter 并返回 alreadyEnabled。
	app.post("/enable-rendering", async (c) => {
		const body = await c.req.json().catch(() => null);
		const parsed = EnableRenderingSchema.safeParse(body);
		if (!parsed.success) return c.json({ ok: false, err: "chromePath 必填" }, 400);
		const engines = opts.deps.runtime.engines;
		if (!engines) return c.json({ ok: false, err: "engines 未就绪" }, 503);
		const { chromePath } = parsed.data;
		try {
			const pup = createPuppeteer(chromePath);
			const enabled = engines.enableImageRendering(pup);
			if (!enabled) {
				await pup.dispose(); // 已启用 → 刚构造的 adapter 多余,释放
				return c.json({ ok: true, alreadyEnabled: true });
			}
			currentPuppeteer = pup;
			opts.onPuppeteerEnabled?.(pup);
			await opts.persistChromePath?.(chromePath);
			log.info(`[cards] 卡片渲染已热启用 · chromePath=${chromePath}`);
			return c.json({ ok: true, chromePath });
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

	// One ImageRenderer reused across requests. Lazy — only constructed when
	// the first real-fetch / sc / guard path actually runs, so deployments
	// without BN_CHROME_PATH don't spin one up needlessly.
	//
	// 每次请求都 updateConfig 一遍传入的 style — 否则用户在 Cards 页改完颜色后
	// 第一次 /preview 构造一个 renderer 后,后续改色就不生效(renderer 是 lazy 单例)。
	let imageRenderer: ImageRenderer | null = null;
	function getImageRenderer(style: PreviewStyle): ImageRenderer | null {
		if (!currentPuppeteer) return null;
		const config = {
			cardColorStart: style.cardColorStart,
			cardColorEnd: style.cardColorEnd,
			font: style.font ?? "PingFang SC, sans-serif",
			hideDesc: style.hideDesc ?? false,
			hideFollower: style.hideFollower ?? false,
			glassOpacity: style.glassOpacity,
			glassClear: style.glassClear,
			backgroundImage: style.backgroundImages?.[0] ?? "",
		};
		if (!imageRenderer) {
			imageRenderer = new ImageRenderer({
				serviceCtx: opts.deps.runtime.serviceCtx,
				puppeteer: currentPuppeteer,
				config,
				// 背景图 id → data URL(读 <dataDir>/assets/card-bg);sc/guard/真实拉取走 generate* 解析。
				resolveAsset: (id) => readCardBgDataUrl(opts.deps.store.bootstrap.dataDir, id),
			});
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
				const my = await opts.api.getMyselfInfo();
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
			const renderer = getImageRenderer(style);
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
			const renderer = getImageRenderer(style);
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
				const renderer = getImageRenderer(style);
				if (!renderer) throw new Error("puppeteer 未就绪");
				if (!opts.api) throw new Error("auth system 未就绪 — 后端账号尚未登录");
				const roomId =
					content.roomId?.trim() ||
					(await resolveRoomIdFromUid(opts.api, content.uid?.trim() ?? ""));
				const buffer = await renderRealLive(opts.api, renderer, roomId, style, layout?.live);
				return { buffer, mime: "image/jpeg" };
			} catch (err) {
				if (!fallback) throw err;
				log.info(`[cards] live 真实渲染失败,回退示例数据:${(err as Error).message}`);
			}
		}
		if (kind === "dyn" && content?.uid?.trim()) {
			try {
				const renderer = getImageRenderer(style);
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
		// (不经 ImageRenderer,未登录也能调色)。背景图在此解析成 data URL 注入。
		const bgDataUrl = await readCardBgDataUrl(
			opts.deps.store.bootstrap.dataDir,
			style.backgroundImages?.[0] ?? "",
		);
		const { component, props, title, htmlWidth } = buildPreviewSpec(kind, style, layout, bgDataUrl);
		const html = await renderCard(component, props, {
			title,
			font: style.font ?? "PingFang SC, sans-serif",
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
					err: "puppeteer 未配置 — 设置 BN_CHROME_PATH 环境变量或 yaml chromePath 字段指向本地 Chromium",
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
export async function resolveMasterInfo(
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
		{ cardColorStart: style.cardColorStart, cardColorEnd: style.cardColorEnd },
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
): PreviewSpec {
	const backgroundImage = bgDataUrl || undefined;
	if (kind === "live") {
		return {
			component: LiveCard,
			props: { ...buildLivePreviewProps(style), layout: layout?.live, backgroundImage },
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
		hideDesc: style.hideDesc ?? false,
		hideFollower: style.hideFollower ?? false,
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
