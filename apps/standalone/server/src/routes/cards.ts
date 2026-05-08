/**
 * `POST /api/cards/preview` — render a sample card via puppeteer-core and
 * return base64 PNG. Used by the Cards page's right-side live preview.
 *
 * First iteration only supports `kind: "live"` — the LiveCard template is
 * exported from packages/image; mock data fills in the LiveCardProps shape
 * so operators see how their style choices land before any real notification
 * goes out. Other kinds (dyn / sc / guard) return 501 until their templates
 * + mock data are wired here.
 *
 * 503 path — when the operator hasn't set BN_CHROME_PATH (or chromePath in
 * yaml) we don't try to launch puppeteer. The route reports the missing
 * config so the Cards page can render an actionable hint.
 */

import { LiveCard, type LiveCardProps, renderCard } from "@bilibili-notify/image";
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

		if (kind !== "live") {
			return c.json<PreviewResponse>(
				{ ok: false, err: `kind=${kind} 暂未接入真实渲染（仅 live 已支持）` },
				501,
			);
		}

		try {
			const html = await renderCard(LiveCard, buildLivePreviewProps(style), {
				title: "卡片预览 · 直播",
				font: style.font ?? "PingFang SC, sans-serif",
				htmlWidth: 600,
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

function buildLivePreviewProps(style: z.infer<typeof StyleSchema>): LiveCardProps {
	return {
		hideDesc: style.hideDesc ?? false,
		followerDisplay: style.followerDisplay ?? true,
		cardColorStart: style.cardColorStart,
		cardColorEnd: style.cardColorEnd,
		data: {
			user_cover:
				"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 338'%3E%3Crect width='600' height='338' fill='%23FB7299'/%3E%3Ctext x='50%25' y='50%25' fill='white' font-size='32' text-anchor='middle' dominant-baseline='middle'%3ECover%3C/text%3E%3C/svg%3E",
			keyframe: "",
			title: "【赛博朋克 2077】资料片实况首播！",
			area_name: "游戏",
			description: "今晚 7 点开始，欢迎围观。这是一段示例直播间简介。",
			online: 12_345,
		},
		username: "示例 UP 主",
		userface:
			"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%2300AEEC'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='30' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E",
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
