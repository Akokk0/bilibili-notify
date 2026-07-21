import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS, type FeatureKey, makeEmptySubscription } from "../../types/domain";
import {
	colorFromUid,
	platformSupportsAtAll,
	routingAlignedToFeatures,
	subscribedFeatures,
	UP_COLORS,
} from "./helpers";

/**
 * 回归:订阅卡片的特性标签必须反映「订阅项主开关」(overrides.features,缺省继承
 * DEFAULT_FEATURE_FLAGS),而非 routing。此前 UpCard 据 routing 判定 —— follow 模式
 * 加推送目标会把目标灌进全部 9 个特性的 routing,导致卡片恒显全部标签。
 */
describe("subscribedFeatures", () => {
	it("无 overrides:返回 DEFAULT_FEATURE_FLAGS 中默认开启的特性", () => {
		const sub = makeEmptySubscription("100");
		expect(subscribedFeatures(sub)).toEqual([
			"dynamic",
			"live",
			"liveEnd",
			"wordcloud",
			"liveSummary",
		]);
	});

	it("overrides 关掉某默认开启的特性 → 不出现", () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { dynamic: false } };
		expect(subscribedFeatures(sub)).not.toContain("dynamic");
	});

	it("overrides 开启某默认关闭的特性 → 出现", () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { superchat: true } };
		expect(subscribedFeatures(sub)).toContain("superchat");
	});

	it("routing 灌满全部目标也不影响结果 —— 只看主开关,不看 routing", () => {
		const sub = makeEmptySubscription("100");
		// 模拟 follow 模式加推送目标:全部 9 个特性的 routing 都塞了同一个目标。
		for (const k of Object.keys(sub.routing) as FeatureKey[]) sub.routing[k] = ["t-1"];
		// 主开关只留 dynamic(其余默认开启的全关掉)。
		sub.overrides = {
			features: { live: false, liveEnd: false, wordcloud: false, liveSummary: false },
		};
		expect(subscribedFeatures(sub)).toEqual(["dynamic"]);
	});
});

/**
 * 平台对 @全体 的支持能力。QQ 官方机器人在群聊 @全体需特殊权限,后端适配器对
 * at-all 段是 best-effort 跳过(apps/server/src/platforms/qq-official.ts),据此前端
 * 在 @全体 开关上提示并禁用;onebot / webhook 正常支持。
 */
describe("platformSupportsAtAll", () => {
	it("QQ 官方机器人不支持 @全体", () => {
		expect(platformSupportsAtAll("qq-official")).toBe(false);
	});

	it("onebot / webhook 支持 @全体", () => {
		expect(platformSupportsAtAll("onebot")).toBe(true);
		expect(platformSupportsAtAll("webhook")).toBe(true);
	});
});

/**
 * 切到「自定义」推送模式时,target 的 routing 应对齐订阅项生效特性 —— 而非维持
 * follow 模式灌进的全 9 项(否则自定义矩阵默认全开)。
 */
describe("routingAlignedToFeatures", () => {
	const DEFAULT_ON: FeatureKey[] = ["dynamic", "live", "liveEnd", "wordcloud", "liveSummary"];
	const DEFAULT_OFF: FeatureKey[] = [
		"liveGuardBuy",
		"superchat",
		"specialDanmaku",
		"specialUserEnter",
	];

	it("follow 模式灌满全 9 项 → 对齐后只留生效特性", () => {
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1"];
		const routing = routingAlignedToFeatures(sub, "t-1");
		for (const k of DEFAULT_ON) expect(routing[k]).toContain("t-1");
		for (const k of DEFAULT_OFF) expect(routing[k]).not.toContain("t-1");
	});

	it("target 原本不在任何 routing → 只加进生效特性", () => {
		const sub = makeEmptySubscription("100");
		const routing = routingAlignedToFeatures(sub, "t-1");
		expect(routing.dynamic).toEqual(["t-1"]);
		expect(routing.superchat).toEqual([]);
	});

	it("跟随 overrides:开 superchat 则纳入,关 dynamic 则剔除", () => {
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1"];
		sub.overrides = { features: { superchat: true, dynamic: false } };
		const routing = routingAlignedToFeatures(sub, "t-1");
		expect(routing.superchat).toContain("t-1");
		expect(routing.dynamic).not.toContain("t-1");
	});

	it("不影响其它 target", () => {
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1", "t-2"];
		const routing = routingAlignedToFeatures(sub, "t-1");
		for (const k of FEATURE_KEYS) expect(routing[k]).toContain("t-2");
	});
});

/**
 * UP 主配色 —— 卡片、头像、图表线、Tab 圆点都吃 `colorFromUid`。
 *
 * 守三件事:颜色够多、**两两分得开**、**没有发闷的芥末/橄榄色**。
 *
 * 背景:最早是 8 色 `hash % 8`,其中 `#FF6699` 与 `#FB7299` 的 ΔE2000 只有 2.4
 * (肉眼就是同一个粉),实际可辨的只剩 7 种 —— 用户原话「稍微多订阅一些就全是
 * 重复的」。中途试过纯按 uid 连续取色(不设调色板),被否掉:完全同色是没了,但
 * 「有点像、分不清」的比例反而翻倍,且黄绿区扫出一片芥末色。最后一条测试就是
 * 那次的教训 —— 光看色差不够,调性也得钉住。
 */

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
