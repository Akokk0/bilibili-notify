/**
 * **醒目留言卡与上舰卡的现状**(㉓a 钉住,㉓b / ㉓c 之前不许悄悄变)。
 *
 * 这两种卡今天没有任何中立类型:价位档在出图器里按价格算、舰长宣告语在块库里写死、金额与时长直接
 * 拼进 props。㉓ 要把档位搬到 B 站那一侧、把两种卡的入口与输入换掉,先在这里把今天的行为钉成**从公开
 * 入口进、读出图 HTML** 的断言 —— 入口换名时测试跟着改调用,断言的值不许动(除非那一步在批准清单
 * 里登记过)。卡片字节快照(`card-baseline.test.ts`)钉的是整张卡,看不出「哪个价位落哪一档」。
 *
 * 做法:截图那一步换成替身、把灌进去的 HTML 留下来,再用 jsdom 读;不开浏览器、不联网。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ImageRenderer } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";

// 卡里的头像 / 徽章都是远端地址,渲染器会在 Node 这边预取。测试不许真去拉,一律 404。
beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 404 })),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

interface Harness {
	renderer: ImageRenderer;
	/** 灌进截图替身的每一份 HTML。 */
	captured: string[];
	/** `logger.debug` 收到的每一行。 */
	debugLines: string[];
}

function makeHarness(): Harness {
	const captured: string[] = [];
	const debugLines: string[] = [];
	const page = {
		setContent: async (html: string) => {
			captured.push(html);
		},
		waitForFunction: async () => undefined,
		$: async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		}),
		screenshot: async () => Buffer.from("fake-jpeg"),
		close: async () => {},
	};
	const serviceCtx: ServiceContext = {
		logger: {
			debug: (line: string) => {
				debugLines.push(line);
			},
			info() {},
			warn() {},
			error() {},
		},
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const renderer = new ImageRenderer({
		serviceCtx,
		puppeteer: { page: async () => page } as unknown as PuppeteerLike,
		config: { font: "sans-serif" },
		resolveAsset: async () => "",
		resolveFontFace: async () => "",
	});
	return { renderer, captured, debugLines };
}

const docOf = (html: string): Document => new JSDOM(html).window.document;

// ── 醒目留言:价位 → 六档 ──────────────────────────────────────────────────────

/** 一张醒目留言卡画出来的**档位相关**的三样:起止两枚档位色、时长胶囊上的字。 */
interface ScTier {
	color: string;
	colorEnd: string;
	duration: string;
}

async function scTierOf(price: number): Promise<ScTier> {
	const h = makeHarness();
	await h.renderer.generateSCCard({
		senderFace: "",
		senderName: "示例观众",
		masterName: "示例主播",
		text: "加油",
		price,
	});
	const doc = docOf(h.captured[0] ?? "");
	// 档位色注在外框(`frame`)的 inline 变量上,起色 / 止色各一枚。
	const frame = doc.querySelector<HTMLElement>('[data-bn~="frame"]');
	return {
		color: frame?.style.getPropertyValue("--bn-card-tier-color") ?? "",
		colorEnd: frame?.style.getPropertyValue("--bn-card-tier-color-end") ?? "",
		duration: doc.querySelector('[data-block="duration"] span')?.textContent ?? "",
	};
}

/** 六档的色对与时长(按元:<50 / 50–99 / 100–499 / 500–999 / 1000–1999 / ≥2000)。 */
const SC_TIERS: Record<1 | 2 | 3 | 4 | 5 | 6, ScTier> = {
	1: { color: "#a8e6cf", colorEnd: "#88d8b0", duration: "60秒" },
	2: { color: "#74b9ff", colorEnd: "#0984e3", duration: "2分钟" },
	3: { color: "#a29bfe", colorEnd: "#6c5ce7", duration: "5分钟" },
	4: { color: "#fd79a8", colorEnd: "#e84393", duration: "30分钟" },
	5: { color: "#fdcb6e", colorEnd: "#e17055", duration: "1小时" },
	6: { color: "#ff7675", colorEnd: "#d63031", duration: "2小时" },
};

describe("醒目留言卡:价位落在哪一档(现状)", () => {
	// 五条线两侧各一个价:49 | 50、99 | 100、499 | 500、999 | 1000、1999 | 2000。
	// 验红(实测):把 `styles.ts` 里 `getSCLevel` 的 `>= 500` 改成 `>= 600`,只有线上的那一行(50 元)红;
	// 改成 `>= 400`,只有线下的那一行(49 元)红;`>= 1000` 改成 `> 1000`,100 元那一行红 —— 两侧都要钉。
	it.each([
		[1, 1],
		[30, 1],
		[49, 1],
		[50, 2],
		[99, 2],
		[100, 3],
		[499, 3],
		[500, 4],
		[999, 4],
		[1000, 5],
		[1999, 5],
		[2000, 6],
		[5000, 6],
	] as const)("%s 元 → 第 %s 档的色对与时长", async (price, tier) => {
		expect(await scTierOf(price)).toEqual(SC_TIERS[tier]);
	});
});

// ── 上舰卡 ────────────────────────────────────────────────────────────────────

/** 照 `room-session` 交给出图器的样子:房管标记缺省 0。 */
function guardArgs(over: { guardLevel?: number; isAdmin?: number } = {}) {
	return [
		{
			guardLevel: (over.guardLevel ?? 3) as 1 | 2 | 3,
			uname: "示例观众",
			face: "",
			isAdmin: over.isAdmin ?? 0,
		},
		{ masterAvatarUrl: "", masterName: "示例主播" },
	] as const;
}

describe("上舰卡:宣告语原文(现状)", () => {
	// 逐字钉:引号是半角双引号、换行是真换行,舰长那句带「号」(总督与提督没有)。
	// 验红:改 `blocks/guard.tsx` 里 `GUARD_DESC` 任一句的任一个字,对应那一档红。
	it.each([
		[1, '"示例观众"上任\n"示例主播"大航海舰队总督！'],
		[2, '"示例观众"就任\n"示例主播"大航海舰队提督！'],
		[3, '"示例观众号"加入\n"示例主播"大航海舰队！'],
	] as const)("guardLevel=%s → 宣告语", async (level, desc) => {
		const h = makeHarness();
		await h.renderer.generateGuardCard(...guardArgs({ guardLevel: level }));
		const doc = docOf(h.captured[0] ?? "");
		expect(doc.querySelector('[data-block="text"] [data-bn="text"]')?.textContent).toBe(desc);
	});
});

describe("上舰卡:房管与未知档(现状,㉓c 会删房管那一格)", () => {
	// 现状:买舰的人是房管,主播那颗胶囊里的名字被换成「房管」。㉓c 把这一格连同接口一起删掉。
	// 验红:把 `blocks/guard.tsx` 的 master 块里 `p.isAdmin ? "房管" : p.masterName` 改成只取 masterName,
	// 第一条红;反过来把条件改成恒真,第二条红。
	it("isAdmin 为真 → 主播位置显示「房管」", async () => {
		const h = makeHarness();
		await h.renderer.generateGuardCard(...guardArgs({ isAdmin: 1 }));
		const doc = docOf(h.captured[0] ?? "");
		expect(doc.querySelector('[data-bn="masterName"]')?.textContent).toBe("房管");
	});

	it("isAdmin 为 0 → 主播位置显示主播名", async () => {
		const h = makeHarness();
		await h.renderer.generateGuardCard(...guardArgs({ isAdmin: 0 }));
		const doc = docOf(h.captured[0] ?? "");
		expect(doc.querySelector('[data-bn="masterName"]')?.textContent).toBe("示例主播");
	});

	// 现状:认不出的档位,出图器日志里的档名回落「上舰」(只是日志里那个词;出卡本身随后因为没有这一档
	// 的档色而失败)。三档的档名也钉着,免得「回落」把已知档名吞了。
	// 验红:把 `image-renderer.ts` 里 `?? "上舰"` 改成别的字,第一条红;把数组里 `"舰长"` 改掉,第二条红。
	it("认不出的档位 → 日志里的档名是「上舰」;已知三档是总督 / 提督 / 舰长", async () => {
		const unknown = makeHarness();
		await expect(
			unknown.renderer.generateGuardCard(...guardArgs({ guardLevel: 9 })),
		).rejects.toThrow("生成上舰卡片失败");
		expect(unknown.debugLines).toContain("[guard] 开始渲染上舰卡片：示例观众 → 示例主播（上舰）");

		for (const [level, name] of [
			[1, "总督"],
			[2, "提督"],
			[3, "舰长"],
		] as const) {
			const known = makeHarness();
			await known.renderer.generateGuardCard(...guardArgs({ guardLevel: level }));
			expect(known.debugLines).toContain(
				`[guard] 开始渲染上舰卡片：示例观众 → 示例主播（${name}）`,
			);
		}
	});
});
