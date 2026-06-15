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
import type { NotificationPayload } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
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
});

/** /api/cards/test-push 响应 —— 与 push.ts 的 TestResponse 同形。 */
export interface TestPushResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

const RENDER_TIMEOUT_MS = 20_000;

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
		};
		if (!imageRenderer) {
			imageRenderer = new ImageRenderer({
				serviceCtx: opts.deps.runtime.serviceCtx,
				puppeteer: currentPuppeteer,
				config,
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
				if (my?.code !== 0 || !my.data?.mid) return null;
				const card = await opts.api.getUserCardInfo(String(my.data.mid));
				if (card?.code === 0 && card.data?.card?.face) {
					const name = card.data.card.name || my.data.uname;
					const avatar = card.data.card.face;
					loggedInCache = { name, avatar, ts: now };
					return { name, avatar };
				}
			} catch (err) {
				log.warn(`[cards] resolve logged-in account failed: ${(err as Error).message}`);
			}
		}
		return null;
	}

	// 渲染一张样例卡片 → JPEG / PNG Buffer。/preview 与 /test-push 共用。失败抛 Error
	// (消息直接面向用户)。SC / Guard 走 ImageRenderer;live / dyn 有 content 走真实
	// 拉取,否则虚构 mock 数据。调用方须先确认 currentPuppeteer 存在。
	async function renderPreviewCard(
		kind: PreviewKind,
		style: PreviewStyle,
		content: PreviewContent,
	): Promise<{ buffer: Buffer; mime: string }> {
		const puppeteer = currentPuppeteer;
		if (!puppeteer) throw new Error("puppeteer 未就绪");

		if (kind === "sc") {
			const renderer = getImageRenderer(style);
			if (!renderer) throw new Error("puppeteer 未就绪");
			// 登录账号 = SC 发送者(「我在别人直播间发条 SC 会长啥样」)。
			const me = await getLoggedInAccount();
			const buffer = await renderer.generateSCCard({
				senderFace: me?.avatar ?? SVG_AVATAR_FAN,
				senderName: me?.name ?? "示例粉丝",
				masterName: "示例 UP 主",
				masterAvatarUrl: SVG_AVATAR_BLUE,
				text: content?.text?.trim() || "主播加油！这首要听到！示例 UP 主唱得太好了！",
				price: content?.price ?? 30,
			});
			return { buffer, mime: "image/jpeg" };
		}
		if (kind === "guard") {
			const renderer = getImageRenderer(style);
			if (!renderer) throw new Error("puppeteer 未就绪");
			// 登录账号 = 新舰长(触发上舰事件的人);显式 text 覆写仍优先。
			const me = await getLoggedInAccount();
			const uname = content?.text?.trim() || me?.name || "示例新舰长";
			const face = me?.avatar ?? SVG_AVATAR_PINK;
			const buffer = await renderer.generateGuardCard(
				{ guardLevel: (content?.level ?? 3) as 1 | 2 | 3, uname, face, isAdmin: 0 },
				{ masterAvatarUrl: SVG_AVATAR_BLUE, masterName: "示例 UP 主" },
			);
			return { buffer, mime: "image/jpeg" };
		}
		// Live + Dyn:有 content 走真实拉取,把用户输入错误原样抛出。
		if (kind === "live" && content?.roomId?.trim()) {
			const renderer = getImageRenderer(style);
			if (!renderer) throw new Error("puppeteer 未就绪");
			if (!opts.api) throw new Error("auth system 未就绪 — 后端账号尚未登录");
			const buffer = await renderRealLive(opts.api, renderer, content.roomId.trim(), style);
			return { buffer, mime: "image/jpeg" };
		}
		if (kind === "dyn" && content?.uid?.trim()) {
			const renderer = getImageRenderer(style);
			if (!renderer) throw new Error("puppeteer 未就绪");
			if (!opts.api) throw new Error("auth system 未就绪 — 后端账号尚未登录");
			const buffer = await renderRealDynamic(
				opts.api,
				renderer,
				content.uid.trim(),
				content.offset ?? 1,
				style,
			);
			return { buffer, mime: "image/jpeg" };
		}
		// Live + Dyn 空 content:虚构 mock 数据,走 renderCard + screenshot 流水线
		// (不经 ImageRenderer,未登录也能调色)。
		const { component, props, title, htmlWidth } = buildPreviewSpec(kind, style);
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
		const { kind, style, content } = parsed.data;
		try {
			const { buffer, mime } = await renderPreviewCard(kind, style, content);
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
		const { targetId, kind, style, content } = parsed.data;

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
			card = await renderPreviewCard(kind, style, content);
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

async function renderRealLive(
	api: BilibiliAPI,
	renderer: ImageRenderer,
	roomId: string,
	style: PreviewStyle,
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
	);
}

async function renderRealDynamic(
	api: BilibiliAPI,
	renderer: ImageRenderer,
	uid: string,
	offset: number,
	style: PreviewStyle,
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

	return renderer.generateDynamicCard(item, {
		cardColorStart: style.cardColorStart,
		cardColorEnd: style.cardColorEnd,
	});
}

// ── Mock pipeline (fall-through path) ────────────────────────────────────────

interface PreviewSpec {
	component: Component;
	props: Record<string, unknown>;
	title: string;
	htmlWidth: number;
}

function buildPreviewSpec(kind: "live" | "dyn", style: PreviewStyle): PreviewSpec {
	if (kind === "live") {
		return {
			component: LiveCard,
			props: buildLivePreviewProps(style),
			title: "卡片预览 · 直播",
			htmlWidth: 600,
		};
	}
	return {
		component: DynamicCard,
		props: buildDynamicPreviewProps(style),
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
	const mainContent = h(
		"div",
		{
			style: "font-size:14px;line-height:1.7;color:#444;padding:6px 0;white-space:pre-line;",
		},
		"这是一段示例动态正文。你可以在「卡片预览·样式」里看到改色后的渲染效果。\n第二行用来演示换行和留白。",
	);
	return {
		cardColorStart: style.cardColorStart,
		cardColorEnd: style.cardColorEnd,
		decorateColor: "#FB7299",
		avatarUrl: SVG_AVATAR_BLUE,
		upName: "示例 UP 主",
		upIsVip: true,
		pubTime: "2026-05-09 18:24:00",
		decorateCardUrl: undefined,
		decorateCardId: undefined,
		topic: "示例话题",
		mainContent,
		forwardCount: "1.2万",
		commentCount: "5,891",
		likeCount: "8.7万",
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
