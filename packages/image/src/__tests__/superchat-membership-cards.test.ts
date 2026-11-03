/**
 * **醒目留言卡与会员卡(原上舰卡)的出卡行为**,从公开入口(`generateSuperchatCard` / `generateMembershipCard`)进、读出图 HTML。
 *
 * ㉓a 先在旧入口上把今天的行为钉住(价位 → 六档的色对与时长、上舰卡三句宣告语),㉓c 换入口后这里跟着改调用:
 * - 「按价格算档」搬去了来源那一侧(`superchatEventFromLiveEvent`,price → rank 的线由 `superchat-event.test.ts` 钉),所以
 *   这里钉的是 **rank → 色对与时长**:六档的色对一字没动、时长的写法改成核心统一的 `formatDuration`
 *   (「60秒 / 2分钟 / 5分钟 / 30分钟」→「1分 / 2分 / 5分 / 30分」,主人定的);
 * - 宣告语三句原文(舰长那句带「号」)不变,只是不再写死在块库里,由调用方交入、由出图器用 `interpolate` 填;
 * - 房管那一格、「上舰」档名日志都随旧入口一起没了(主人定的:会员卡没有房管这一格)。
 * 卡片字节快照(`card-baseline.test.ts`)钉的是整张卡,看不出「哪个档落哪个色」,所以这里单独钉。
 *
 * 做法:截图那一步换成替身、把灌进去的 HTML 留下来,再用 jsdom 读;不开浏览器、不联网。
 */

import type { ImageRef, ServiceContext } from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { ImageRenderer, type ImageRendererOptions } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";
import type { MembershipCardInput } from "../templates/membership-card";
import type { SuperchatCardInput } from "../templates/superchat-card";

interface Harness {
	renderer: ImageRenderer;
	/** 灌进截图替身的每一份 HTML。 */
	captured: string[];
}

function makeHarness(extra: Partial<ImageRendererOptions> = {}): Harness {
	const captured: string[] = [];
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
		logger: { debug() {}, info() {}, warn() {}, error() {} },
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
		timezone: () => "Asia/Shanghai",
		...extra,
	});
	return { renderer, captured };
}

const docOf = (html: string): Document => new JSDOM(html).window.document;

/** 外框上注的档位色变量。 */
function tierVariables(doc: Document): { color: string; colorEnd: string } {
	const frame = doc.querySelector<HTMLElement>('[data-bn~="frame"]');
	return {
		color: frame?.style.getPropertyValue("--bn-card-tier-color") ?? "",
		colorEnd: frame?.style.getPropertyValue("--bn-card-tier-color-end") ?? "",
	};
}

// ── 醒目留言:rank → 六档 ──────────────────────────────────────────────────────

function superchat(over: Partial<SuperchatCardInput> = {}): SuperchatCardInput {
	return {
		viewer: { name: "示例观众" },
		creator: { name: "示例主播" },
		text: "加油",
		amount: 30,
		currency: "CNY",
		...over,
	};
}

/** 画一张醒目留言卡,读出档位相关的三样:起止两枚档位色、时长胶囊上的字(没有时长块就是 `undefined`)。 */
async function scOf(input: SuperchatCardInput): Promise<{
	color: string;
	colorEnd: string;
	duration: string | undefined;
	doc: Document;
}> {
	const h = makeHarness();
	await h.renderer.generateSuperchatCard(input);
	const doc = docOf(h.captured[0] ?? "");
	return {
		...tierVariables(doc),
		duration: doc.querySelector('[data-block="duration"] span')?.textContent ?? undefined,
		doc,
	};
}

/** 六档的色对(默认配色表)。 */
const SC_COLORS_BY_RANK = {
	1: ["#a8e6cf", "#88d8b0"],
	2: ["#74b9ff", "#0984e3"],
	3: ["#a29bfe", "#6c5ce7"],
	4: ["#fd79a8", "#e84393"],
	5: ["#fdcb6e", "#e17055"],
	6: ["#ff7675", "#d63031"],
} as const;

describe("醒目留言卡:rank 取默认配色表里的色、留言时长走 formatDuration", () => {
	// 这六行是 ㉓a 钉的六档色对,时长是 ㉓c 第 3 步改的写法。
	// 验红:把 `styles.ts` 的 `DEFAULT_TIER_COLORS` 里任一对色改一位,对应那一档红;把 `superchat-view.ts` 的
	// `formatDuration(0, durationSec * 1000)` 换成别的排法,时长那列红。
	it.each([
		[1, 60, "1分"],
		[2, 120, "2分"],
		[3, 300, "5分"],
		[4, 1800, "30分"],
		[5, 3600, "1小时"],
		[6, 7200, "2小时"],
	] as const)(
		"rank %s、留言挂 %s 秒 → 第 %s 档的色对与时长「%s」",
		async (rank, durationSec, text) => {
			const out = await scOf(superchat({ tier: { rank, durationSec } }));
			expect([out.color, out.colorEnd]).toEqual(SC_COLORS_BY_RANK[rank]);
			expect(out.duration).toBe(text);
		},
	);

	// 验红:去掉 `effectiveTierRank` 里的上界夹取,超出 6 的会取不到色(渲染出空的档位色),这条红。
	it("rank 超出 6 → 用最后一色(第 6 档)", async () => {
		for (const rank of [7, 12, 999]) {
			const out = await scOf(superchat({ tier: { rank } }));
			expect([out.color, out.colorEnd], `rank ${rank}`).toEqual(SC_COLORS_BY_RANK[6]);
		}
	});

	// 验红:把 `effectiveTierRank` 里没有 `tier` 时回 1 的那一句改成回 6,这条红。
	it("没有 tier → 用第一色", async () => {
		const out = await scOf(superchat());
		expect([out.color, out.colorEnd]).toEqual(SC_COLORS_BY_RANK[1]);
	});

	// rank 不合规(0、负数、小数、NaN)也落在 1–6 之内:不让一个怪值把色渲染成空。
	it("rank 不合规 → 夹进 1–6(0 与负数用第一色,小数向下取整,NaN 当没有)", async () => {
		const cases: [number, 1 | 3][] = [
			[0, 1],
			[-5, 1],
			[3.9, 3],
			[Number.NaN, 1],
		];
		for (const [rank, expected] of cases) {
			const out = await scOf(superchat({ tier: { rank } }));
			expect([out.color, out.colorEnd], `rank ${rank}`).toEqual(SC_COLORS_BY_RANK[expected]);
		}
	});

	// 验红:把 `superchat-view.ts` 里 `durationText` 的守卫去掉(让没给时长也排一个「0秒」),这条红;
	// 把块里 `p.duration ? … : null` 改成恒画,同样红。
	it("没有留言时长 → 不画时长块(不再按价位反推)", async () => {
		const out = await scOf(superchat({ tier: { rank: 4 } }));
		expect(out.doc.querySelector('[data-block="duration"]')).toBeNull();
		expect(out.duration).toBeUndefined();
		// 时长不是正的有限数也不画。
		for (const durationSec of [0, -3, Number.NaN]) {
			const bad = await scOf(superchat({ tier: { rank: 4, durationSec } }));
			expect(
				bad.doc.querySelector('[data-block="duration"]'),
				`durationSec ${durationSec}`,
			).toBeNull();
		}
	});

	// 金额走 `formatAmount`:币种符号按币种,人民币整数不带小数、不加千分位。
	// 验红:把 `superchat-view.ts` 里 `formatAmount(input.amount, input.currency)` 的币种写死成 "CNY",美元那条红。
	it.each([
		[30, "CNY", "¥30"],
		[2000, "CNY", "¥2000"],
		[30.5, "CNY", "¥30.5"],
		[30, "USD", "US$30"],
	] as const)("金额 %s %s → 卡上写「%s」", async (amount, currency, text) => {
		const out = await scOf(superchat({ amount, currency }));
		expect(out.doc.querySelector('[data-block="amount"] [data-bn="text"]')?.textContent).toBe(text);
	});

	// 页面标题是出图 HTML 的一部分(字节基准里写死),入口自己决定它 —— 与卡种键 `sc` 无关,叫「醒目留言通知」。
	// 验红:把 `image-renderer.ts` 里醒目留言入口的 `title: "醒目留言通知"` 改掉,这条红。
	it("页面标题是「醒目留言通知」", async () => {
		const out = await scOf(superchat());
		expect(out.doc.title).toBe("醒目留言通知");
	});

	it("观众名与留言原样上卡", async () => {
		const out = await scOf(superchat({ viewer: { name: "某某" }, text: "今晚加更" }));
		expect(out.doc.querySelector('[data-block="viewerName"]')?.textContent).toBe("某某");
		expect(out.doc.querySelector('[data-block="message"]')?.textContent).toContain("今晚加更");
	});
});

describe("醒目留言卡:头像是图库引用,解析不到就不画", () => {
	const VIEWER = `${"a".repeat(63)}1.png` as ImageRef;
	const MASTER = `${"b".repeat(63)}2.png` as ImageRef;

	// 验红:把 `image-renderer.ts` 的 `generateSuperchatCard` 里收集引用那几句去掉,这条红。
	it("引用解析到了 → 观众头像与主播头像都画出来(地址取解析口给的)", async () => {
		const h = makeHarness({
			resolveImageRef: async (ref) =>
				`data:image/png;base64,${ref === VIEWER ? "VIEWER" : "MASTER"}`,
		});
		await h.renderer.generateSuperchatCard(
			superchat({
				viewer: { name: "某某", avatar: VIEWER },
				creator: { name: "主播", avatar: MASTER },
			}),
		);
		const doc = docOf(h.captured[0] ?? "");
		expect(doc.querySelector('[data-block="viewerAvatar"] img')?.getAttribute("src")).toBe(
			"data:image/png;base64,VIEWER",
		);
		expect(doc.querySelector('[data-bn="creatorAvatar"]')?.getAttribute("style") ?? "").toContain(
			"data:image/png;base64,MASTER",
		);
	});

	it("没有头像,或引用解析不到 → 头像块与主播小头像都不画,不抛", async () => {
		const none = makeHarness();
		await none.renderer.generateSuperchatCard(superchat());
		const lost = makeHarness({ resolveImageRef: async () => undefined });
		await lost.renderer.generateSuperchatCard(
			superchat({
				viewer: { name: "某某", avatar: VIEWER },
				creator: { name: "主播", avatar: MASTER },
			}),
		);
		for (const h of [none, lost]) {
			const doc = docOf(h.captured[0] ?? "");
			expect(doc.querySelector('[data-block="viewerAvatar"]')).toBeNull();
			expect(doc.querySelector('[data-bn="creatorAvatar"]')).toBeNull();
		}
	});
});

// ── 会员卡 ────────────────────────────────────────────────────────────────────

function membership(over: Partial<MembershipCardInput> = {}): MembershipCardInput {
	return {
		viewer: { name: "示例观众" },
		creator: { name: "示例主播" },
		tier: { name: "某档", rank: 1 },
		...over,
	};
}

async function memberOf(
	input: MembershipCardInput,
	extra: Partial<ImageRendererOptions> = {},
): Promise<Document> {
	const h = makeHarness(extra);
	await h.renderer.generateMembershipCard(input);
	return docOf(h.captured[0] ?? "");
}

const announcementOf = (doc: Document): string | undefined =>
	doc.querySelector('[data-block="announcement"] [data-bn="text"]')?.textContent ?? undefined;

describe("会员卡:宣告语由调用方交入、由 interpolate 填", () => {
	// 冻住三句历史输入:来源自己的档位表由集成测试钉,出图器只认中立档位输入。
	it.each([
		[
			"总督",
			3,
			'"{viewer}"上任\n"{name}"大航海舰队总督！',
			'"示例观众"上任\n"示例主播"大航海舰队总督！',
		],
		[
			"提督",
			2,
			'"{viewer}"就任\n"{name}"大航海舰队提督！',
			'"示例观众"就任\n"示例主播"大航海舰队提督！',
		],
		[
			"舰长",
			1,
			'"{viewer}号"加入\n"{name}"大航海舰队！',
			'"示例观众号"加入\n"示例主播"大航海舰队！',
		],
	] as const)("%s 的宣告语填入观众名与主播名", async (name, rank, announcement, expected) => {
		const doc = await memberOf(membership({ tier: { name, rank, announcement } }));
		expect(announcementOf(doc)).toBe(expected);
	});

	// 验红:把 `membership-view.ts` 里传给 `interpolate` 的 `tier` 键去掉,这条红。
	it("三个占位符:{viewer} 观众名、{name} 主播名、{tier} 档名;不认识的占位符原样留着", async () => {
		const doc = await memberOf(
			membership({
				viewer: { name: "阿甲" },
				creator: { name: "阿乙" },
				tier: { name: "银牌", announcement: "{viewer}→{name}:{tier}{other}" },
			}),
		);
		expect(announcementOf(doc)).toBe("阿甲→阿乙:银牌{other}");
	});

	// 验红:把块里 `p.announcement ? … : null` 改成恒画,这条红。
	it("档位没声明宣告语 → 不画那一句", async () => {
		const doc = await memberOf(membership({ tier: { name: "某档" } }));
		expect(doc.querySelector('[data-block="announcement"]')).toBeNull();
	});
});

describe("会员卡:档色取 tier.color / colorEnd、徽章取 tier.icon", () => {
	// 验红:把 `membership-view.ts` 里 `[value, value]` 改成 `[value, 别的]`,起止色那条红。
	it("档色取 tier.color;没声明止色 → 起色止色同一个值", async () => {
		const doc = await memberOf(membership({ tier: { name: "某档", color: "#123456" } }));
		expect(tierVariables(doc)).toEqual({ color: "#123456", colorEnd: "#123456" });
	});

	// 验红:把 `membership-view.ts` 里止色改成恒取起色,这条红。
	it("声明了止色 colorEnd → 外框从起色渐变到止色", async () => {
		const doc = await memberOf(
			membership({ tier: { name: "某档", color: "#123456", colorEnd: "#abcdef" } }),
		);
		expect(tierVariables(doc)).toEqual({ color: "#123456", colorEnd: "#abcdef" });
	});

	it("只声明了止色、没有起色 → 整个回落默认色,止色不单独生效", async () => {
		const doc = await memberOf(membership({ tier: { name: "某档", colorEnd: "#abcdef" } }));
		expect(tierVariables(doc)).toEqual({ color: "#a8e6cf", colorEnd: "#a8e6cf" });
	});

	// 验红:把回落改成别的色(比如默认配色表第 2 色),这条红。
	it("没有 color → 默认配色表第一色(#a8e6cf)的起色,起止同值", async () => {
		const doc = await memberOf(membership({ tier: { name: "某档" } }));
		expect(tierVariables(doc)).toEqual({ color: "#a8e6cf", colorEnd: "#a8e6cf" });
	});

	// 验红:让 `coverUrlOf` 在没有引用时退回 `url`,这条红。
	it("徽章只有 url(没有图库引用)→ 不画徽章块:出图只认引用,地址不进卡", async () => {
		const doc = await memberOf(
			membership({ tier: { name: "某档", icon: { url: "data:image/png;base64,BADGE" } } }),
		);
		expect(doc.querySelector('[data-block="icon"]')).toBeNull();
		expect(doc.documentElement.outerHTML).not.toContain("BADGE");
	});

	// 验红:去掉 `image-renderer.ts` 里把 `tier.icon.ref` 加进待解析集合的那一句,这条红。
	it("徽章带 ref → 走图库解析;解析不到就不画徽章", async () => {
		const REF = `${"c".repeat(63)}3.png` as ImageRef;
		const ok = await memberOf(membership({ tier: { name: "某档", icon: { ref: REF } } }), {
			resolveImageRef: async () => "data:image/png;base64,ICON",
		});
		expect(ok.querySelector('[data-block="icon"]')?.getAttribute("style") ?? "").toContain(
			"data:image/png;base64,ICON",
		);
		const lost = await memberOf(membership({ tier: { name: "某档", icon: { ref: REF } } }), {
			resolveImageRef: async () => undefined,
		});
		expect(lost.querySelector('[data-block="icon"]')).toBeNull();
	});

	// 验红:把块里 `p.iconUrl ? … : null` 改成恒画,这条红。
	it("档位没有徽章 → 不画徽章块", async () => {
		const doc = await memberOf(membership({ tier: { name: "某档" } }));
		expect(doc.querySelector('[data-block="icon"]')).toBeNull();
	});
});

describe("会员卡:头像是图库引用,解析不到就不画;观众名与主播名原样上卡", () => {
	const VIEWER = `${"a".repeat(63)}1.png` as ImageRef;
	const MASTER = `${"b".repeat(63)}2.png` as ImageRef;

	it("引用解析到了 → 观众头像与主播小头像都画出来;没有或解析不到 → 都不画", async () => {
		const withAvatars = await memberOf(
			membership({
				viewer: { name: "某某", avatar: VIEWER },
				creator: { name: "主播", avatar: MASTER },
			}),
			{
				resolveImageRef: async (ref) =>
					`data:image/png;base64,${ref === VIEWER ? "VIEWER" : "MASTER"}`,
			},
		);
		expect(withAvatars.querySelector('[data-block="viewerAvatar"] img')?.getAttribute("src")).toBe(
			"data:image/png;base64,VIEWER",
		);
		expect(
			withAvatars.querySelector('[data-bn="creatorAvatar"]')?.getAttribute("style") ?? "",
		).toContain("data:image/png;base64,MASTER");
		const without = await memberOf(membership());
		expect(without.querySelector('[data-block="viewerAvatar"]')).toBeNull();
		expect(without.querySelector('[data-bn="creatorAvatar"]')).toBeNull();
	});

	// 验红:把 `image-renderer.ts` 里会员卡入口的 `title: "上舰通知"` 改掉,这条红。
	it("页面标题是中立的「会员通知」", async () => {
		const doc = await memberOf(membership());
		expect(doc.title).toBe("会员通知");
	});

	it("观众名在用户名胶囊里、主播名在主播胶囊里(没有任何「房管」替换)", async () => {
		const doc = await memberOf(
			membership({ viewer: { name: "某某" }, creator: { name: "某主播" } }),
		);
		expect(doc.querySelector('[data-block="viewerName"]')?.textContent).toBe("某某");
		expect(doc.querySelector('[data-bn="creatorName"]')?.textContent).toBe("某主播");
	});
});
