/**
 * 推送(特性)色表的守卫。
 *
 * 这张表的由来就是「同一份映射抄了五份然后飘了」:上舰在四处是橙、在 toast
 * 里是紫;SC 是 `#fdcb6e` vs `#FFB454`;直播在 Cards 是 `#FF6699`。构建全绿、
 * 测试全绿,只有把两个页面并排摆着才看得出来 —— 所以守卫得钉在「只有一处出处」
 * 这件事本身上,而不是钉某个颜色值。
 *
 * ⑬f:表的键从 0.x 的推送种类名换成特性键(历史行记的就是特性键),家族取值同步改说特性键那套
 * (`dynamic` → `post`、`sc` → `superchat`、`guard` → `membership`,`live` 不变)。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n";
import { FEATURE_KEYS } from "../../types/domain";
import { FEATURE_DESCRIPTORS, familyTone, PUSH_STATUS_META, PUSH_TONE } from "../push-features";

/** 八把特性键,字面量 —— 与活的 FEATURE_KEYS 另有一条对表;少一个就是有特性没上色。 */
const FEATURES = [
	"post",
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
	"viewerChat",
	"viewerEnter",
] as const;

const SRC_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("FEATURE_DESCRIPTORS", () => {
	it("八把特性键一个不少、一个不多(字面量与活的 FEATURE_KEYS 两头都对)", () => {
		expect(Object.keys(FEATURE_DESCRIPTORS).sort()).toEqual([...FEATURES].sort());
		expect(Object.keys(FEATURE_DESCRIPTORS).sort()).toEqual([...FEATURE_KEYS].sort());
	});

	it("家族取值是特性键那套的说法:live / post / superchat / membership,没有 0.x 的 dynamic / sc / guard", () => {
		const families = new Set(Object.values(FEATURE_DESCRIPTORS).map((d) => d.family));
		expect([...families].sort()).toEqual(["live", "membership", "post", "superchat"]);
		expect(Object.keys(PUSH_TONE).sort()).toEqual(
			["derived", "live", "membership", "post", "superchat"].sort(),
		);
	});

	it("四个家族色互不相同 —— 撞色就等于两种推送分不开", () => {
		const family = [PUSH_TONE.live, PUSH_TONE.post, PUSH_TONE.superchat, PUSH_TONE.membership];
		expect(new Set(family).size).toBe(family.length);
	});

	it("familyTone:直播家族五把全归粉,其余各归各的", () => {
		for (const s of [
			"liveStart",
			"liveStreaming",
			"liveEnd",
			"viewerEnter",
			"viewerChat",
		] as const) {
			expect(`${s} → ${familyTone(s)}`).toBe(`${s} → ${PUSH_TONE.live}`);
		}
		expect(familyTone("post")).toBe(PUSH_TONE.post);
		expect(familyTone("superchat")).toBe(PUSH_TONE.superchat);
		expect(familyTone("membership")).toBe(PUSH_TONE.membership);
	});

	it("四个主特性(开播 / 作品 / SC / 上舰)的每种一色 = 它的家族色 —— 两套口径在这四把上必须一致", () => {
		// 衍生那几把刻意不同(toast 一次弹一条,独立色好认);主特性不同就是漂移。
		for (const s of ["liveStart", "post", "superchat", "membership"] as const) {
			expect(`${s}: ${FEATURE_DESCRIPTORS[s].tone}`).toBe(`${s}: ${familyTone(s)}`);
		}
	});

	/** 分类与事件使用不同口径，B 站专用叫法由来源描述提供。 */
	it("每把键的分类标签与事件标签按中性叫法显示", () => {
		expect(
			Object.fromEntries(
				FEATURES.map((s) => [s, [FEATURE_DESCRIPTORS[s].label, FEATURE_DESCRIPTORS[s].eventLabel]]),
			),
		).toEqual({
			post: ["作品", "作品"],
			liveStart: ["开播", "开播"],
			liveStreaming: ["直播", "正在直播"],
			liveEnd: ["下播", "下播"],
			membership: ["会员", "会员加入"],
			superchat: ["SC", "SC"],
			viewerChat: ["弹幕", "特别弹幕"],
			viewerEnter: ["进房", "特别进房"],
		});
	});

	it("六态各有标签与色:失败红,部分失败与无目标警示色,已送达绿,被挡下的与被过滤的是未激活的灰", () => {
		expect(Object.keys(PUSH_STATUS_META).sort()).toEqual(
			["delivered", "partial", "failed", "no-targets", "silenced", "filtered"].sort(),
		);
		// 被过滤的作品只是留痕,和「已静音」同一支灰。
		expect(PUSH_STATUS_META.filtered).toEqual({
			label: "已过滤",
			tone: "var(--color-bn-inactive)",
		});
		// 被静音 / 免扰挡下的不是「该看一眼的事」:不用警示色,用「未发送」那一支灰。
		expect(PUSH_STATUS_META.silenced).toEqual({
			label: "已静音",
			tone: "var(--color-bn-inactive)",
		});
		expect(PUSH_STATUS_META.delivered.label).toBe("已送达");
		expect(PUSH_STATUS_META.partial.label).toBe("部分失败");
		expect(PUSH_STATUS_META.failed.label).toBe("失败");
		expect(PUSH_STATUS_META["no-targets"].label).toBe("无目标");
		expect(PUSH_STATUS_META.failed.tone).toBe("var(--color-bn-danger)");
		expect(PUSH_STATUS_META.partial.tone).toBe(PUSH_STATUS_META["no-targets"].tone);
		expect(PUSH_STATUS_META.partial.tone).not.toBe(PUSH_STATUS_META.failed.tone);
		expect(PUSH_STATUS_META.delivered.tone).toBe("var(--color-bn-success)");
	});

	it("每把键两套标签都非空 —— 事件口径与分类口径都有人用", () => {
		for (const s of FEATURES) {
			expect(`${s}: ${FEATURE_DESCRIPTORS[s].label.length > 0}`).toBe(`${s}: true`);
			expect(`${s}: ${FEATURE_DESCRIPTORS[s].eventLabel.length > 0}`).toBe(`${s}: true`);
		}
	});
});

/** 扫描范围:站点源码 + 平台中立组件库。库那份最容易漏,它取不到 `push-features`。 */
const ROOTS: ReadonlyArray<readonly [string, string]> = [
	[SRC_DIR, "apps/web/src"],
	[join(SRC_DIR, "../../../packages/ui/src"), "packages/ui/src"],
];

/** 目录下所有 `.ts` / `.tsx`,跳过测试与色表本尊。 */
async function sources(root: string): Promise<string[]> {
	const all = await readdir(root, { recursive: true, withFileTypes: true });
	return all
		.filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
		.map((e) => relative(root, join(e.parentPath, e.name)))
		.filter((rel) => !/__tests__|\.test\.|push-features\.ts$/.test(rel));
}

describe("没有第二份推送色表", () => {
	/**
	 * 复发形态是「在页面里再手搓一张 `Record<HistorySource, string>`」。这里扫的是
	 * 那五个曾经各存一份的文件:它们必须从 push-features 取色,而不是自己写十六进制。
	 */
	const CONSUMERS = [
		"components/toast-shell.tsx",
		"pages/Overview.tsx",
		"pages/History.tsx",
		"pages/Cards.tsx",
		"pages/subscriptions/SubscriptionCard.tsx",
	];

	it("五个曾经各存一份的文件都从 push-features 取", async () => {
		for (const rel of CONSUMERS) {
			const src = await readFile(join(SRC_DIR, rel), "utf8");
			expect(`${rel}: ${src.includes("config/push-features")}`).toBe(`${rel}: true`);
		}
	});

	/**
	 * 判据是「**四个家族色里凑齐三个以上**」而不是「出现任何一个」—— 那才是一张
	 * 色表的签名。单独一个不算:Dashboard 的日志级别表里 info 用 `#00AEEC`,那是
	 * 「信息=蓝」这个语义,与推送类型无关,不该被这条拦下来。
	 *
	 * 这条真抓到过东西:收表时先漏了 Dashboard 趋势图的图例(第六份副本)。
	 */
	/**
	 * **扫全目录,不扫白名单。** 上一版这里钉的是上面那五个文件,于是白名单外的第六份
	 * 副本可以安安稳稳躺着 —— `packages/ui` 的 `StatsBar` 就那么躺了一整轮:四个家族色
	 * 分毫不差地写死在堆叠柱里,而守卫连 `packages/ui` 这个目录都没看过。
	 *
	 * 现在两个目录整棵扫。库那边尤其要扫:它是平台中立的,取不到 `push-features`,所以
	 * 「就地抄一份」在那儿是最省事的选择,也就最容易复发。
	 */
	it("两个目录里都不再出现成套的家族色字面量", async () => {
		const hexes = [PUSH_TONE.live, PUSH_TONE.post, PUSH_TONE.superchat, PUSH_TONE.membership];
		const findings: string[] = [];
		for (const [root, label] of ROOTS) {
			for (const rel of await sources(root)) {
				const raw = await readFile(join(root, rel), "utf8");
				// 注释抹掉:好几处文档正**举例说明**旧写法长什么样,那不是又抄了一张表。
				const src = raw
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/.*$/gm, "")
					.toLowerCase();
				const hit = hexes.filter((h) => src.includes(h.toLowerCase()));
				if (hit.length >= 3) findings.push(`${label}/${rel}: ${hit.join(" ")}`);
			}
		}
		expect(findings).toEqual([]);
	});

	/**
	 * **点名过的漂移值,一个都不许再出现。**
	 *
	 * `push-features.ts` 的文档抬头列了收表时清掉的三个近亲:`#FF6699`(live 粉漂了一档)、
	 * `#7A5AF8`(guard 在 toast 里变成紫)、`#FFB454`(sc 黄漂了一档)。它们与正主肉眼
	 * 难分,所以上面那条「凑齐三个」的判据放它们过去 —— `System.tsx` 的模块色表就靠这
	 * 个空子留了 `#FF6699` 一整轮,和同表里 core 那格的 `#FB7299` 并排放着,谁也看不出
	 * 是两个色。
	 *
	 * 这条不数个数:出现一个就报。这三个值本身就是错的,没有「只用一个所以没关系」。
	 */
	it("点名过的漂移色一个都不许再出现", async () => {
		const DRIFT = ["#FF6699", "#7A5AF8", "#FFB454"];
		const findings: string[] = [];
		for (const [root, label] of ROOTS) {
			for (const rel of await sources(root)) {
				const src = (await readFile(join(root, rel), "utf8"))
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/.*$/gm, "")
					.toLowerCase();
				const hit = DRIFT.filter((h) => src.includes(h.toLowerCase()));
				if (hit.length > 0) findings.push(`${label}/${rel}: ${hit.join(" ")}`);
			}
		}
		expect(findings).toEqual([]);
	});

	it("push-features 自己是唯一出处 —— config/ 下没有第二张", async () => {
		const files = await readdir(join(SRC_DIR, "config"));
		expect(files.filter((f) => /feature|kind|tone|source/i.test(f) && f.endsWith(".ts"))).toEqual([
			"push-features.ts",
		]);
	});

	/**
	 * 分区装饰色表(`section-accents.ts`)是**另一件事** —— 它按「这一屏讲哪件事」上色,
	 * 与 kind 无关,所以名字里刻意避开 `tone` 那个词(本仓库里 tone 特指推送家族色)。
	 *
	 * 但它确实有条把两者混起来的路:往里塞一整套家族色,于是又成了第二张推送色表。
	 * 判据同上面那条 —— 四个家族色凑齐三个以上才算,单独撞一个不算:`persona` 那抹
	 * 暖黄与 `PUSH_TONE.superchat` **恰好同值而不同义**(特别关注弹幕自己的推送色是绿的),
	 * 那是巧合,已在表里写明「SC 调色时这里不跟着动」。
	 *
	 * `guard` 那档反过来 —— 它讲的**就是**上舰,所以直接引用 `PUSH_TONE.membership`,
	 * 不另抄字面量。
	 */
	it("分区装饰色表里不许出现成套的家族色", async () => {
		const raw = await readFile(join(SRC_DIR, "config/section-accents.ts"), "utf8");
		// 注释先抹掉:那份文档正在**举例说明**旧写法长什么样(「`#FB7299` 配 `#b8425d`」),
		// 连注释一起扫的话,写得越清楚越容易被自己的守卫判成违规(实测当场误报)。
		const src = raw
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.toLowerCase();
		const hexes = [PUSH_TONE.live, PUSH_TONE.post, PUSH_TONE.superchat, PUSH_TONE.membership];
		const hit = hexes.filter((h) => src.includes(h.toLowerCase()));
		expect(hit.length < 3, `凑齐了 ${hit.join(" ")} —— 这已经是一张推送色表了`).toBe(true);
	});
});

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

it("feature and delivery labels read current locale without changing their keys or presentation metadata", () => {
	const live = FEATURE_DESCRIPTORS.liveStreaming;
	for (const [
		locale,
		start,
		streaming,
		end,
		event,
		delivered,
		partial,
		failed,
		none,
		muted,
		filtered,
	] of [
		[
			"en",
			"Live start",
			"Live",
			"Live end",
			"Streaming",
			"Delivered",
			"Partially failed",
			"Failed",
			"No targets",
			"Silenced",
			"Filtered",
		],
		[
			"ja",
			"配信開始",
			"配信",
			"配信終了",
			"配信中",
			"送信済み",
			"一部失敗",
			"失敗",
			"送信先なし",
			"通知停止",
			"フィルター済み",
		],
		[
			"zh-TW",
			"開播",
			"直播",
			"下播",
			"正在直播",
			"已送達",
			"部分失敗",
			"失敗",
			"無目標",
			"已靜音",
			"已過濾",
		],
	] as const) {
		i18n.set({ locale, voice: "plain" });
		expect([
			FEATURE_DESCRIPTORS.liveStart.label,
			live.label,
			FEATURE_DESCRIPTORS.liveEnd.label,
		]).toEqual([start, streaming, end]);
		expect(live.eventLabel).toBe(event);
		expect([
			PUSH_STATUS_META.delivered.label,
			PUSH_STATUS_META.partial.label,
			PUSH_STATUS_META.failed.label,
			PUSH_STATUS_META["no-targets"].label,
			PUSH_STATUS_META.silenced.label,
			PUSH_STATUS_META.filtered.label,
		]).toEqual([delivered, partial, failed, none, muted, filtered]);
		expect(FEATURE_DESCRIPTORS.liveStreaming).toBe(live);
		expect(live.family).toBe("live");
		expect(live.icon).toBe("live");
		expect(live.tone).toBe("#FB7299");
	}
});
