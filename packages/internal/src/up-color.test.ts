/**
 * 单元测试 — UP 主配色。
 *
 * 守三件事:颜色够多、**两两分得开**、**没有发闷的芥末/橄榄色**。
 *
 * 背景:最早是 8 色 `hash % 8`,其中 `#FF6699` 与 `#FB7299` 的 ΔE2000 只有 2.4
 * (肉眼就是同一个粉),实际可辨的只剩 7 种 —— 用户原话「稍微多订阅一些就全是
 * 重复的」。中途试过纯按 uid 连续取色(不设调色板),被否掉:完全同色是没了,但
 * 「有点像、分不清」的比例反而翻倍,且黄绿区扫出一片芥末色。第四条测试就是那次
 * 的教训 —— 光看色差不够,调性也得钉住。
 */

import { describe, expect, it } from "vite-plus/test";
import { colorFromUid, extensionColorSeed, UP_COLORS, upColor } from "./constants";

/** sRGB hex → CIE Lab。只为算色差与体检明度,不追求极致精度。 */
function toLab(hex: string): [number, number, number] {
	const to = (i: number) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const [r, g, b] = [to(1), to(3), to(5)];
	const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
	const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
	const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
	const [fx, fy, fz] = [f(x), f(y), f(z)];
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIE76 色差。公式短,而「排除看不出区别的两个色」这个用途够用。 */
function deltaE(a: string, b: string): number {
	const [l1, a1, b1] = toLab(a);
	const [l2, a2, b2] = toLab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
/** Lab 色相角(度)。 */
const hueOf = (hex: string) => {
	const [, a, b] = toLab(hex);
	return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};

describe("UP 主配色", () => {
	it("调色板至少 20 色 —— 8 色时订阅 4 位就有约 65% 概率撞色", () => {
		expect(UP_COLORS.length).toBeGreaterThanOrEqual(20);
	});

	it("没有重复的十六进制值", () => {
		expect(new Set(UP_COLORS.map((c) => c.toLowerCase())).size).toBe(UP_COLORS.length);
	});

	it("两两都分得开 —— 不重复不代表看得出区别", () => {
		// 旧调色板这条会挂:#FF6699 与 #FB7299 的 ΔE76 只有 7.0。
		let worst = { pair: ["", ""], d: Number.POSITIVE_INFINITY };
		for (let i = 0; i < UP_COLORS.length; i++) {
			for (let j = i + 1; j < UP_COLORS.length; j++) {
				const d = deltaE(UP_COLORS[i] as string, UP_COLORS[j] as string);
				if (d < worst.d) worst = { pair: [UP_COLORS[i] as string, UP_COLORS[j] as string], d };
			}
		}
		expect(
			worst.d,
			`最接近的一对:${worst.pair.join(" 与 ")} ΔE76=${worst.d.toFixed(1)}`,
		).toBeGreaterThanOrEqual(14);
	});

	it("黄到黄绿那段必须够亮 —— 明度一低就发闷成芥末 / 橄榄", () => {
		// 这条是「连续取色」那一版被否掉的直接原因:逐色相取最大彩度,在 Lab 色相
		// 55–125° 且明度偏低时会扫出 #cf9700 #aea300 #84ae04 这类颜色。色差指标
		// 完全看不出问题,只有人眼看得出来,所以单独钉一条。
		const muddy = UP_COLORS.filter((c) => {
			const h = hueOf(c);
			return h >= 55 && h <= 125 && (toLab(c)[0] as number) < 78;
		});
		expect(muddy, `发闷的颜色:${muddy.join(" ")}`).toEqual([]);
	});

	it("明度锁在浅调带里 —— 头像是白色首字母直接压在这个颜色上", () => {
		for (const c of UP_COLORS) {
			const l = toLab(c)[0];
			expect(l, `${c} 的 L*=${l.toFixed(0)}`).toBeGreaterThanOrEqual(60);
			expect(l, `${c} 的 L*=${l.toFixed(0)}`).toBeLessThanOrEqual(84);
		}
	});

	it("同一个 uid 恒得同一个颜色", () => {
		expect(colorFromUid("387654321")).toBe(colorFromUid("387654321"));
	});

	it("颜色一定取自调色板", () => {
		for (const uid of ["1", "946974", "387654321", ""]) {
			expect(UP_COLORS).toContain(colorFromUid(uid));
		}
	});

	it("真实型 uid 能铺满整个调色板,且分布不过分倾斜", () => {
		// 只有「颜色够多」不够,分配还得散得开:B 站 uid 是纯数字,哈希在小模数下
		// 容易扎堆,那样加再多颜色也只会用到其中几个。
		const buckets = new Map<string, number>();
		for (let i = 0; i < 20_000; i++) {
			const c = colorFromUid(String(1_000_000 + i * 7919));
			buckets.set(c, (buckets.get(c) ?? 0) + 1);
		}
		expect(buckets.size).toBe(UP_COLORS.length);
		const counts = [...buckets.values()];
		expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(1.5);
	});
});

/**
 * 按人取色(ADR-0019 决策 73 / ADR-0020 决策 15):B 站按 uid,拓展按「拓展 id:外部 id」。这份算法以前只在
 * 面板里有(`apps/web/src/utils/up-display.ts`),锐评卡在服务端出图也要同一个颜色,所以搬进这里。
 *
 * 下面的色值是拿**搬之前**那份代码(git 里面板的 `extensionColorSeed` + 这里的 `colorFromUid`)现算出来
 * 写死的,不是拿新代码算的 —— 搬家之后订阅卡、历史行、统计页上同一个人的颜色一个都不许变。
 */
describe("upColor — 按人取色", () => {
	it("B 站按 uid:与搬之前一字不差", () => {
		const before: Array<[string, string]> = [
			["1", "#ffaf7b"],
			["12345", "#fb7299"],
			["946974", "#01b355"],
			["387654321", "#ff9c89"],
			["2", "#05d6bd"],
			["672328094", "#02b088"],
		];
		for (const [uid, color] of before) expect(upColor({ uid }), uid).toBe(color);
	});

	it("拓展按「拓展 id:外部 id」:与搬之前一字不差(外部 id 带 / 也照算)", () => {
		const before: Array<[string, string, string]> = [
			["douyin", "12345", "#ffaf7b"],
			["douyin", "MS4wLjABAAAA-abc/def", "#fb7299"],
			["fake-source", "1", "#b3cd2f"],
			["kuaishou", "3xabc", "#ff93d1"],
			["douyin", "1", "#fb7299"],
		];
		for (const [extensionId, externalId, color] of before) {
			expect(upColor({ extensionId, externalId }), `${extensionId} ${externalId}`).toBe(color);
			expect(extensionColorSeed(extensionId, externalId)).toBe(`${extensionId}:${externalId}`);
		}
	});

	it("拓展不按外部 id 取色:外部 id 恰好等于某个 B 站 uid,种子也不是那串 uid", () => {
		expect(extensionColorSeed("douyin", "12345")).not.toBe("12345");
		expect(upColor({ extensionId: "douyin", externalId: "12345" })).toBe(
			colorFromUid("douyin:12345"),
		);
	});

	it("拓展两格缺一格不算拓展;两支都认不出退调用方给的种子(历史行给订阅 id)", () => {
		expect(upColor({ uid: "12345", extensionId: "douyin" })).toBe("#fb7299");
		expect(upColor({}, "s-only")).toBe("#b3cd2f");
	});
});
