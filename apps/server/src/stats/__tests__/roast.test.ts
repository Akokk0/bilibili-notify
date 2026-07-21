/**
 * 单元测试 — AI 锐评的回复解析。
 *
 * 模型回什么都有可能,而这张卡的内容是要发到群里的。用例基本都在描述「收到
 * 垃圾时怎么诚实地失败」,而不是「顺利时怎么解析」。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	buildRoastPrompt,
	buildSoloRoastPrompt,
	parseRoastReply,
	parseSoloRoastReply,
	type RoastInput,
} from "../roast.js";

const UPS: RoastInput[] = [
	{
		uid: "100",
		name: "老番茄",
		net7d: 8000,
		netWindow: 29000,
		archives: 6,
		dynamics: 14,
		liveSessions: 12,
		liveHours: 40,
		lastActivityAt: "2026-05-16T10:00:00.000Z",
	},
	{
		uid: "200",
		name: "机智的党妹",
		net7d: -8000,
		netWindow: -22000,
		archives: 1,
		dynamics: 4,
		liveSessions: 0,
		liveHours: 0,
		lastActivityAt: null,
	},
];

const good = {
	pigeon: { i: 1, reason: "一个月就发一条" },
	diligent: { i: 0, reason: "更新最勤" },
	roast: [{ i: 1, comment: "鸽子精本精" }],
	scores: [
		{ i: 0, score: 96 },
		{ i: 1, score: 41 },
	],
	pushText: "本周鸽王诞生 🕊️",
};

describe("parseRoastReply — 正常路径", () => {
	it("下标被映射回 uid", () => {
		const got = parseRoastReply(JSON.stringify(good), UPS);
		expect(got?.pigeon).toEqual({ uid: "200", reason: "一个月就发一条" });
		expect(got?.diligent.uid).toBe("100");
		expect(got?.roast).toEqual([{ uid: "200", comment: "鸽子精本精" }]);
		expect(got?.scores).toEqual([
			{ uid: "100", score: 96 },
			{ uid: "200", score: 41 },
		]);
	});

	it("剥掉 markdown 围栏", () => {
		const got = parseRoastReply(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, UPS);
		expect(got?.pigeon.uid).toBe("200");
	});

	it("剥掉 JSON 前后的客套话", () => {
		const got = parseRoastReply(`好的,这是您要的结果:\n${JSON.stringify(good)}\n希望满意!`, UPS);
		expect(got?.pigeon.uid).toBe("200");
	});

	it("roast / scores 缺失时退化成空数组,不整体失败", () => {
		const got = parseRoastReply(
			JSON.stringify({ pigeon: good.pigeon, diligent: good.diligent }),
			UPS,
		);
		expect(got?.roast).toEqual([]);
		expect(got?.scores).toEqual([]);
	});
});

describe("parseRoastReply — 诚实失败", () => {
	it("完全不是 JSON → null", () => {
		expect(parseRoastReply("我觉得党妹是鸽王呢~", UPS)).toBeNull();
	});

	it("空回复 → null", () => {
		expect(parseRoastReply("", UPS)).toBeNull();
	});

	it("缺 pigeon → null(卡片主体缺一半没什么可展示的)", () => {
		expect(parseRoastReply(JSON.stringify({ diligent: good.diligent }), UPS)).toBeNull();
	});

	it("鸽王下标越界 → null,绝不 clamp 到某个无辜的 UP", () => {
		const bad = { ...good, pigeon: { i: 99, reason: "乱指" } };
		expect(parseRoastReply(JSON.stringify(bad), UPS)).toBeNull();
	});

	it("负下标同样越界", () => {
		const bad = { ...good, diligent: { i: -1, reason: "乱指" } };
		expect(parseRoastReply(JSON.stringify(bad), UPS)).toBeNull();
	});
});

describe("parseRoastReply — 局部脏数据只丢局部", () => {
	it("锐评里的越界下标被丢弃,其余保留", () => {
		const bad = {
			...good,
			roast: [
				{ i: 0, comment: "好" },
				{ i: 42, comment: "谁?" },
			],
		};
		const got = parseRoastReply(JSON.stringify(bad), UPS);
		expect(got?.roast).toEqual([{ uid: "100", comment: "好" }]);
	});

	it("评分越界被夹到 0..100 —— 它只驱动一根进度条,不值得整卡失败", () => {
		const bad = {
			...good,
			scores: [
				{ i: 0, score: 999 },
				{ i: 1, score: -5 },
			],
		};
		const got = parseRoastReply(JSON.stringify(bad), UPS);
		expect(got?.scores).toEqual([
			{ uid: "100", score: 100 },
			{ uid: "200", score: 0 },
		]);
	});

	it("小数评分取整", () => {
		const bad = { ...good, scores: [{ i: 0, score: 87.6 }] };
		expect(parseRoastReply(JSON.stringify(bad), UPS)?.scores[0]?.score).toBe(88);
	});
});

describe("buildRoastPrompt", () => {
	it("带上全部 UP 与下标", () => {
		const p = buildRoastPrompt(UPS, 30);
		expect(p).toContain("老番茄");
		expect(p).toContain("机智的党妹");
		expect(p).toContain("2 位");
	});

	it("把 null 标成「无记录」并叮嘱模型别当成偷懒", () => {
		const p = buildRoastPrompt(UPS, 30);
		expect(p).toContain("无记录");
		expect(p).toContain("不要据此判定该 UP 偷懒");
	});

	it("要求 JSON 的 i 字段用下标回指,而不是写名字", () => {
		expect(buildRoastPrompt(UPS, 30)).toContain("不要写名字");
	});

	it("**单独**叮嘱 pushText 要写名字 —— 那段是给群友看的,他们看不到下标表", () => {
		// 曾经只有一句笼统的「所有对 UP 的引用一律使用下标」,模型照单全收,把它
		// 也套到了 pushText 上,推出去的周报长这样:
		//   「鸽王i=0,30天零投稿零直播却涨粉;劳模i=5直播3场独撑排面。」
		// 群里没人知道 i=0 是谁。下标纪律只对 JSON 结构字段成立,必须分开讲。
		const p = buildRoastPrompt(UPS, 30);
		expect(p).toContain("名称");
		expect(p).toMatch(/pushText[^\n]*/);
		expect(p).toContain("不要出现下标");
	});
});

describe("parseRoastReply — pushText 里的下标回指必须换回名字", () => {
	const withPush = (pushText: string) =>
		parseRoastReply(JSON.stringify({ ...good, pushText }), UPS);

	it("`i=0` 换成对应 UP 的名称", () => {
		expect(withPush("本周鸽王i=1,劳模i=0")?.pushText).toBe("本周鸽王机智的党妹,劳模老番茄");
	});

	it("等号两侧的空格、以及省略等号的写法一并认", () => {
		expect(withPush("i = 0 与 i1 与 i 1")?.pushText).toBe("老番茄 与 机智的党妹 与 机智的党妹");
	});

	it("越界下标原样保留 —— 换成任何真名都是往无辜的 UP 头上安话", () => {
		// 留着 i=99 至少一眼看得出是模型在胡说;替换掉就成了一句读起来天衣无缝的诬告。
		expect(withPush("鸽王是i=99")?.pushText).toBe("鸽王是i=99");
	});

	it("不碰名字里本来就带的字母数字", () => {
		// 替换只在 `i` 前是词边界时发生,`Ai2` 这种名字中间的 i 不受影响。
		expect(withPush("Ai2 今天很努力")?.pushText).toBe("Ai2 今天很努力");
	});

	it("模型老实写了名字时原样透传", () => {
		expect(withPush("老番茄本周更新最勤 🎉")?.pushText).toBe("老番茄本周更新最勤 🎉");
	});
});

// ── 单 UP 锐评 ───────────────────────────────────────────────────────────────

const SOLO = UPS[1] as RoastInput;

const goodSolo = {
	verdict: "一个月就发一条,鸽子精本精",
	score: 32,
	highlights: [
		{ label: "涨粉", comment: "掉了两万" },
		{ label: "投稿", comment: "只有一个" },
	],
	pushText: "党妹本月鸽了 🕊️",
};

describe("buildSoloRoastPrompt", () => {
	it("只放这一位 UP 的数据,不泄漏其他订阅", () => {
		const p = buildSoloRoastPrompt(SOLO, 30);
		expect(p).toContain("机智的党妹");
		expect(p).not.toContain("老番茄");
	});

	it("窗口天数进提示词", () => {
		expect(buildSoloRoastPrompt(SOLO, 90)).toContain("90");
	});

	it("无记录的字段标成「无记录」,并叮嘱模型别当成偷懒", () => {
		const p = buildSoloRoastPrompt(SOLO, 30);
		expect(p).toContain("无记录");
		expect(p).toContain("不要据此判定");
	});
});

describe("parseSoloRoastReply", () => {
	it("解析正常回复", () => {
		const r = parseSoloRoastReply(JSON.stringify(goodSolo), SOLO);
		expect(r?.uid).toBe("200");
		expect(r?.verdict).toBe("一个月就发一条,鸽子精本精");
		expect(r?.score).toBe(32);
		expect(r?.highlights).toHaveLength(2);
	});

	it("剥掉 markdown 围栏", () => {
		const r = parseSoloRoastReply(`\`\`\`json\n${JSON.stringify(goodSolo)}\n\`\`\``, SOLO);
		expect(r?.verdict).toBe(goodSolo.verdict);
	});

	it("评分夹到 0..100 —— 它只驱动一根进度条,夹一下比整卡失败划算", () => {
		expect(parseSoloRoastReply(JSON.stringify({ ...goodSolo, score: 900 }), SOLO)?.score).toBe(100);
		expect(parseSoloRoastReply(JSON.stringify({ ...goodSolo, score: -5 }), SOLO)?.score).toBe(0);
	});

	it("缺少总评 → 整卡失败,不渲染半截结构", () => {
		expect(parseSoloRoastReply(JSON.stringify({ ...goodSolo, verdict: "" }), SOLO)).toBeNull();
	});

	it("不是 JSON → null", () => {
		expect(parseSoloRoastReply("女仆今天不想干活", SOLO)).toBeNull();
	});

	it("highlights 缺省成空数组,不至于整卡失败", () => {
		const { highlights, ...rest } = goodSolo;
		expect(parseSoloRoastReply(JSON.stringify(rest), SOLO)?.highlights).toEqual([]);
	});

	it("uid 从入参带出,不信模型自己写的", () => {
		const r = parseSoloRoastReply(JSON.stringify({ ...goodSolo, uid: "999" }), SOLO);
		expect(r?.uid).toBe("200");
	});
});
