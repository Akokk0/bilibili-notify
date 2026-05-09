/**
 * `POST /api/cards/preview` — render a sample card via puppeteer-core and
 * return base64 PNG. Used by the Cards page's right-side live preview.
 *
 * Supports all four kinds (live / dyn / sc / guard). Each kind has its own
 * fabricated mock data shaped to the corresponding template's prop type;
 * cardColorStart/End from the request flows through verbatim so operators
 * see how their style choices land before any real notification goes out.
 *
 * 503 path — when the operator hasn't set BN_CHROME_PATH (or chromePath in
 * yaml) we don't try to launch puppeteer. The route reports the missing
 * config so the Cards page can render an actionable hint.
 */

import {
	type Component,
	DynamicCard,
	type DynamicCardProps,
	GuardCard,
	type GuardCardProps,
	h,
	LiveCard,
	type LiveCardProps,
	renderCard,
	SCCard,
	type SCCardProps,
} from "@bilibili-notify/image";
import { Hono } from "hono";
import { z } from "zod";
import type { StandalonePuppeteer } from "../runtime/puppeteer.js";
import type { RouteDeps } from "./types.js";

export interface CardsRouteOptions {
	deps: RouteDeps;
	puppeteer: StandalonePuppeteer | null;
}

const StyleSchema = z.object({
	cardColorStart: z.string(),
	cardColorEnd: z.string(),
	cardBasePlateColor: z.string().optional(),
	cardBasePlateBorder: z.string().optional(),
	font: z.string().optional(),
	hideDesc: z.boolean().optional(),
	followerDisplay: z.boolean().optional(),
});

const PreviewRequestSchema = z.object({
	kind: z.enum(["live", "dyn", "sc", "guard"]),
	style: StyleSchema,
});

export interface PreviewResponse {
	ok: boolean;
	dataUrl?: string;
	err?: string;
}

const RENDER_TIMEOUT_MS = 20_000;

export function createCardsRoute(opts: CardsRouteOptions): Hono {
	const app = new Hono();
	const log = opts.deps.runtime.serviceCtx.logger;

	app.post("/preview", async (c) => {
		const body = (await c.req.json().catch(() => null)) as unknown;
		const parsed = PreviewRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json<PreviewResponse>({ ok: false, err: "invalid_request" }, 400);
		}
		const { kind, style } = parsed.data;

		if (!opts.puppeteer) {
			return c.json<PreviewResponse>(
				{
					ok: false,
					err: "puppeteer 未配置 — 设置 BN_CHROME_PATH 环境变量或 yaml chromePath 字段指向本地 Chromium",
				},
				503,
			);
		}

		try {
			const { component, props, title, htmlWidth } = buildPreviewSpec(kind, style);
			const html = await renderCard(component, props, {
				title,
				font: style.font ?? "PingFang SC, sans-serif",
				htmlWidth,
			});
			const buffer = await screenshotHtml(opts.puppeteer, html);
			const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
			return c.json<PreviewResponse>({ ok: true, dataUrl });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error(`[cards] preview render failed: ${msg}`);
			return c.json<PreviewResponse>({ ok: false, err: msg }, 500);
		}
	});

	return app;
}

interface PreviewSpec {
	component: Component;
	props: Record<string, unknown>;
	title: string;
	htmlWidth: number;
}

function buildPreviewSpec(
	kind: "live" | "dyn" | "sc" | "guard",
	style: z.infer<typeof StyleSchema>,
): PreviewSpec {
	if (kind === "live") {
		return {
			component: LiveCard,
			props: buildLivePreviewProps(style),
			title: "卡片预览 · 直播",
			htmlWidth: 600,
		};
	}
	if (kind === "dyn") {
		return {
			component: DynamicCard,
			props: buildDynamicPreviewProps(style),
			title: "卡片预览 · 动态",
			htmlWidth: 600,
		};
	}
	if (kind === "sc") {
		return {
			component: SCCard,
			props: buildScPreviewProps(style),
			title: "卡片预览 · SC",
			htmlWidth: 430,
		};
	}
	return {
		component: GuardCard,
		props: buildGuardPreviewProps(style),
		title: "卡片预览 · 上舰",
		htmlWidth: 430,
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

function buildLivePreviewProps(style: z.infer<typeof StyleSchema>): LiveCardProps {
	return {
		hideDesc: style.hideDesc ?? false,
		followerDisplay: style.followerDisplay ?? true,
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

function buildDynamicPreviewProps(style: z.infer<typeof StyleSchema>): DynamicCardProps {
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

function buildScPreviewProps(style: z.infer<typeof StyleSchema>): SCCardProps {
	return {
		senderFace: SVG_AVATAR_FAN,
		senderName: "示例粉丝",
		masterName: "示例 UP 主",
		masterAvatarUrl: SVG_AVATAR_BLUE,
		text: "主播加油！这首要听到！示例 UP 主唱得太好了！",
		price: 30,
		duration: "2 分钟",
		bgColor: [style.cardColorStart, style.cardColorEnd] as const,
	};
}

function buildGuardPreviewProps(style: z.infer<typeof StyleSchema>): GuardCardProps {
	return {
		captainImgUrl: SVG_AVATAR_PINK,
		guardLevel: 3 as GuardCardProps["guardLevel"],
		uname: "示例新舰长",
		face: SVG_AVATAR_PINK,
		isAdmin: 0,
		masterAvatarUrl: SVG_AVATAR_BLUE,
		masterName: "示例 UP 主",
		bgColor: [style.cardColorStart, style.cardColorEnd],
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
