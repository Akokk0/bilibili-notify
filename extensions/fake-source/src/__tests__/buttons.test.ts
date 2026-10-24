/**
 * 假源页面上的上报按钮(ADR-0019 决策 62 的最后一条):开发时拿它造事件,把「拓展报 → BN 收」那条路在
 * 真机上走一遍。
 *
 * 按钮带不了「点的是哪一行」(决策 42:handler 只收一个 `AbortSignal`),所以每颗都**一次作用于名下所有
 * 开着的订阅** —— 按外部 id 报,同一个人两条订阅也只报一次(宿主自己会扇出)。造出来的数据要**确定、
 * 可复现**:序号递增、不掷骰子,主人按第三下看见的就是「第 3 条」。
 *
 * 「造出来的过得了宿主那道校验」在这里证不了(拓展连测试也够不到 internal),由开机级的
 * `apps/server/src/__tests__/fake-source-buttons-e2e.test.ts` 装真的假源去证。
 */

import { readFile } from "node:fs/promises";
import type {
	CreatorProfileReport,
	ExtensionBlock,
	ExtensionRichText,
	ExtensionView,
	LiveDetails,
	LiveSignalReport,
	PostReport,
} from "@bilibili-notify/extension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	bootFakeSource,
	type HarnessSub,
	type HeardKind,
	type HeardReport,
	IMAGE_REF_PATTERN,
} from "./harness.js";

const T = Date.UTC(2026, 8, 23, 12);

beforeEach(() => {
	// 只假 Date:时刻要钉死才比得了「可复现」,定时器与 Promise 照走真的。
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T);
});
afterEach(() => {
	vi.useRealTimers();
});

function sub(externalId: string, enabled: boolean): HarnessSub {
	return { externalId, enabled };
}

/** 甲两条开着的(推给两组群)、乙一条开着的、丙一条停用的。 */
const PEOPLE = [
	sub("person-a", true),
	sub("person-a", true),
	sub("person-b", true),
	sub("person-c", false),
];

/** 清单里声明的动作名。 */
async function manifestActions(): Promise<string[]> {
	const manifest = JSON.parse(
		await readFile(new URL("../../extension.json", import.meta.url), "utf8"),
	) as { actions?: string[] };
	return manifest.actions ?? [];
}

/** 上报的第 `kind` 种,按先后。 */
function valuesOf<T>(reports: readonly HeardReport[], kind: HeardKind): T[] {
	return reports.filter((r) => r.kind === kind).map((r) => r.value as T);
}

/** 直播信号里某一种(`start` / `status` / `end`),按先后。 */
function signalsOf<K extends LiveSignalReport["kind"]>(
	reports: readonly HeardReport[],
	kind: K,
): Extract<LiveSignalReport, { kind: K }>[] {
	return valuesOf<LiveSignalReport>(reports, "live").filter(
		(v): v is Extract<LiveSignalReport, { kind: K }> => v.kind === kind,
	);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function isPng(bytes: unknown): boolean {
	return bytes instanceof Uint8Array && PNG_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** 字里有没有这个数(前后不紧挨别的数字 —— 「12」里不算有「1」)。 */
function mentions(text: string | undefined, n: number): boolean {
	return new RegExp(`(^|\\D)${n}(\\D|$)`).test(text ?? "");
}

/** 链接是 https、落在 `.invalid` 上 —— 不会真的解析到别人家。 */
function isHarmlessUrl(url: string | undefined): boolean {
	const parsed = new URL(url ?? "");
	return parsed.protocol === "https:" && parsed.hostname.endsWith(".invalid");
}

const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

function plain(text: ExtensionRichText): string {
	if (typeof text === "string") return text;
	return text
		.map((run) =>
			typeof run === "string" ? run : "b" in run ? run.b : "mono" in run ? run.mono : "",
		)
		.join("");
}

function noticesOf(view: ExtensionView): Extract<ExtensionBlock, { type: "notice" }>[] {
	return (view.page ?? []).filter(
		(block): block is Extract<ExtensionBlock, { type: "notice" }> => block.type === "notice",
	);
}

/** 页上所有调拓展的按钮(单独一块的与挂在提示条上的都算):文案 → 动作名。 */
function actionButtons(view: ExtensionView): { label: string; action: string }[] {
	const out: { label: string; action: string }[] = [];
	for (const block of view.page ?? []) {
		const button =
			block.type === "button" ? block.button : block.type === "notice" ? block.button : undefined;
		if (button?.kind === "action") out.push({ label: button.label, action: button.action });
	}
	return out;
}

describe("七颗按钮", () => {
	it("页上有五颗正常的、两颗报坏的,文案照定的;每颗的动作都在清单的 actions 里", async () => {
		const buttons = actionButtons(bootFakeSource(PEOPLE).view());
		expect(buttons.map((b) => b.label)).toEqual([
			"报一条作品",
			"开播",
			"下播",
			"报资料",
			"报直播状态",
			"报一条带坏图的作品",
			"报一条多一格的作品",
		]);
		const declared = await manifestActions();
		for (const { action } of buttons) expect(declared).toContain(action);
	});

	/** 宿主的规矩:没声明的动作注册当场抛、声明了没接的按了回「代码没接」。两头都得对上。 */
	it("代码接的动作与清单声明的一一对应", async () => {
		const fake = bootFakeSource(PEOPLE);
		expect([...fake.actionNames()].sort()).toEqual([...(await manifestActions())].sort());
	});

	/** 清单 `events` 声明了开播 + 下播,宿主据此推出周期直播并要求 `fetchLiveStatus`。 */
	it("来源登记了 start / stop / searchCreators / fetchLiveStatus", () => {
		expect(bootFakeSource().members()).toEqual([
			"fetchLiveStatus",
			"searchCreators",
			"start",
			"stop",
		]);
	});
});

describe("作用于谁", () => {
	it("按外部 id 报:每个开着的人一次(同一个人两条订阅也只一次),停用的那个人不报", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.press("report.post");
		expect(fake.reports().map((r) => [r.kind, r.externalId])).toEqual([
			["post", "person-a"],
			["post", "person-b"],
		]);
	});

	it("没有开着的订阅:七颗按哪颗都不报,页上说一句「还没有开着的订阅」,并喊面板重取", async () => {
		const fake = bootFakeSource([sub("person-c", false)]);
		const before = fake.statusChanges();
		for (const { action } of actionButtons(fake.view())) await fake.press(action);
		expect(fake.reports()).toEqual([]);
		expect(fake.statusChanges()).toBeGreaterThan(before);
		const warn = noticesOf(fake.view()).find((n) => n.tone === "warn");
		expect(plain(warn?.text ?? "")).toContain("还没有开着的订阅");
	});

	it("报完了页上说一句报给了几个人", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.press("report.post");
		const said = noticesOf(fake.view()).map((n) => plain(n.text));
		expect(said.some((text) => text.includes("报一条作品") && mentions(text, 2))).toBe(true);
	});

	it("图库存不下图:动作失败,原话带到面板,什么都没报", async () => {
		const fake = bootFakeSource(PEOPLE, { refuseStore: () => "图库满了" });
		await expect(fake.press("report.post")).rejects.toThrow(/图库满了/);
		expect(fake.reports()).toEqual([]);
	});

	it("交进来时 signal 已经中止(超时 / 拓展停用):一条都不报,按它的 reason 拒掉", async () => {
		const fake = bootFakeSource(PEOPLE);
		const controller = new AbortController();
		const reason = new DOMException("拓展 fake-source 停用了", "AbortError");
		controller.abort(reason);
		await expect(fake.press("report.post", controller.signal)).rejects.toBe(reason);
		expect(fake.reports()).toEqual([]);
	});

	it("来源停了(stop 之后):按钮照实回「来源没在跑」,什么都不报,页上也这么说", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.stop();
		await expect(fake.press("report.post")).rejects.toThrow(/来源没在跑/);
		expect(fake.reports()).toEqual([]);
		const error = noticesOf(fake.view()).find((n) => n.tone === "error");
		expect(plain(error?.text ?? "")).toContain("来源没在跑");
	});
});

describe("报一条作品", () => {
	/**
	 * 话题照契约报名字(不带 `#`),一条作品只报一个:图文报「假话题」(正文里有 #假话题,卡上既有标签又有
	 * 上色);视频报「城市散步」,正文末尾也是 `#城市散步`。
	 */
	it("话题:图文报「假话题」(正文里有 #假话题);视频报「城市散步」,正文末尾是 #城市散步", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.post");
		await fake.press("report.post");
		const [first, second] = valuesOf<PostReport>(fake.reports(), "post");

		expect(first?.post.topic).toBe("假话题");
		expect(first?.post.text).toContain("#假话题");

		expect(second?.post.topic).toBe("城市散步");
		expect(second?.post.text).toMatch(/#城市散步$/);
	});

	/** 话题上色靠 `richText`:片段的字拼起来要正好等于正文(否则宿主丢掉富文本),末尾是话题片段。 */
	it("richText 的片段拼起来等于正文,末尾是与 topic 同名的话题片段", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.post");
		await fake.press("report.post");
		for (const report of valuesOf<PostReport>(fake.reports(), "post")) {
			const segments = report.post.richText ?? [];
			expect(segments.map((one) => one.text).join("")).toBe(report.post.text);
			expect(segments.at(-1)).toMatchObject({
				kind: "topic",
				text: `#${report.post.topic}`,
				name: report.post.topic,
			});
		}
	});

	it("单数是图文(正文 + 三张图库里的 png + 互动数),双数是视频(封面 png、标题、时长、简介、播放数 + 互动数)", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.post");
		await fake.press("report.post");
		const [first, second] = valuesOf<PostReport>(fake.reports(), "post");

		expect(first?.post.publishedAt).toBe(T);
		expect(first?.post.text).toEqual(expect.any(String));
		expect(first?.post.images).toHaveLength(3);
		for (const ref of first?.post.images ?? []) {
			expect(ref).toMatch(IMAGE_REF_PATTERN);
			expect(isPng(fake.imageBytes(ref))).toBe(true);
		}
		expect(first?.post.video).toBeUndefined();

		expect(second?.post.images).toBeUndefined();
		const video = second?.post.video;
		expect(video?.cover).toMatch(IMAGE_REF_PATTERN);
		expect(isPng(fake.imageBytes(video?.cover))).toBe(true);
		expect(mentions(video?.title, 2)).toBe(true);
		expect(video?.durationSec).toBeGreaterThan(0);
		expect(video?.description).toEqual(expect.any(String));
		expect(isCount(video?.views)).toBe(true);

		for (const report of [first, second]) {
			expect(isCount(report?.post.stats?.likes)).toBe(true);
			expect(isCount(report?.post.stats?.comments)).toBe(true);
			expect(isCount(report?.post.stats?.shares)).toBe(true);
			expect(isHarmlessUrl(report?.url)).toBe(true);
		}
	});

	it("作品 id、链接、正文都带序号,一下一个;两个人同一下拿到的 id 不撞", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.press("report.post");
		await fake.press("report.post");
		const posts = valuesOf<PostReport>(fake.reports(), "post");
		expect(posts).toHaveLength(4);
		const [a1, b1, a2] = posts;
		for (const [post, n] of [
			[a1, 1],
			[b1, 1],
			[a2, 2],
		] as const) {
			expect(mentions(post?.postId, n), post?.postId).toBe(true);
			expect(mentions(post?.url, n), post?.url).toBe(true);
			expect(mentions(post?.post.text, n), post?.post.text).toBe(true);
		}
		expect(new Set(posts.map((p) => p.postId)).size).toBe(4);
	});

	it("没有开着的订阅时按的那一下不占序号", async () => {
		const fake = bootFakeSource([]);
		await fake.press("report.post");
		fake.changeSubscriptions([sub("person-a", true)]);
		await fake.press("report.post");
		const [post] = valuesOf<PostReport>(fake.reports(), "post");
		expect(mentions(post?.postId, 1)).toBe(true);
	});
});

describe("开播 / 报直播状态 / 下播", () => {
	it("开播:链接、开播时刻、带场次的标题、封面(图库引用)、分区、在线与累计人数、点赞、简介都填上", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.liveStart");
		const [start] = signalsOf(fake.reports(), "start");
		const d = start?.details as LiveDetails;
		expect(start?.startedAt).toBe(T);
		expect(isHarmlessUrl(d.url)).toBe(true);
		expect(mentions(d.title, 1)).toBe(true);
		expect(d.cover).toMatch(IMAGE_REF_PATTERN);
		expect(isPng(fake.imageBytes(d.cover))).toBe(true);
		expect(d.category).toEqual(expect.any(String));
		expect(d.currentViewers).toBeGreaterThan(0);
		// 两个人数各给一个看得出区别的数:首页那一列画的是累计观看(决策 75),一眼要认得出不是在线。
		expect(d.totalViewers).toBeGreaterThan(d.currentViewers ?? Number.POSITIVE_INFINITY);
		expect(isCount(d.totalViewers)).toBe(true);
		expect(isCount(d.likes)).toBe(true);
		expect(d.description).toEqual(expect.any(String));
	});

	it("报直播状态:报「在播」,在线与累计每按一次都往上涨;开播时刻沿用开播那一刻,链接同一个", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.liveStart");
		vi.setSystemTime(T + 60_000);
		await fake.press("report.liveStatus");
		vi.setSystemTime(T + 120_000);
		await fake.press("report.liveStatus");
		const [start] = signalsOf(fake.reports(), "start");
		const [s1, s2] = signalsOf(fake.reports(), "status");
		expect([s1?.isLive, s2?.isLive]).toEqual([true, true]);
		const inf = Number.POSITIVE_INFINITY;
		expect(s1?.details.currentViewers).toBeGreaterThan(start?.details.currentViewers ?? inf);
		expect(s2?.details.currentViewers).toBeGreaterThan(s1?.details.currentViewers ?? inf);
		expect(s1?.details.totalViewers).toBeGreaterThan(start?.details.totalViewers ?? inf);
		expect(s2?.details.totalViewers).toBeGreaterThan(s1?.details.totalViewers ?? inf);
		expect([s1?.startedAt, s2?.startedAt]).toEqual([T, T]);
		expect([s1?.details.url, s2?.details.url]).toEqual([start?.details.url, start?.details.url]);
		expect(mentions(s2?.details.title, 1)).toBe(true);
	});

	/**
	 * 不同的动作宿主不挡着并发(决策 42 只挡同一个)。开播还在一个个报的时候按了报直播状态,后面那几个人的
	 * 开播不该沾上涨过的人数 —— 每一下报的是按下那一刻的样子。这里让开播第一次存封面的那一下卡住。
	 */
	it("开播报到一半按了报直播状态:同一下开播,每个人拿到的人数一样", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = bootFakeSource(PEOPLE, {
			holdStore: (index) => (index === 0 ? held : undefined),
		});
		const starting = fake.press("report.liveStart");
		await fake.press("report.liveStatus");
		release();
		await starting;
		const counts = signalsOf(fake.reports(), "start").map((v) => [
			v.details.currentViewers,
			v.details.totalViewers,
		]);
		expect(counts).toHaveLength(2);
		expect(counts[1]).toEqual(counts[0]);
	});

	it("没开播就报直播状态(演 BN 重启过、开播没见着):照样报在播,从这一刻算起", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.liveStatus");
		const [status] = signalsOf(fake.reports(), "status");
		expect(status?.isLive).toBe(true);
		expect(status?.startedAt).toBe(T);
		const d = status?.details as LiveDetails;
		expect(d.currentViewers).toBeGreaterThan(0);
		expect(d.totalViewers).toBeGreaterThan(d.currentViewers ?? Number.POSITIVE_INFINITY);
	});

	it("下播:补上开播时刻;之后再报直播状态是新的一场", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.liveStart");
		vi.setSystemTime(T + 3_600_000);
		await fake.press("report.liveEnd");
		vi.setSystemTime(T + 7_200_000);
		await fake.press("report.liveStatus");
		const [start] = signalsOf(fake.reports(), "start");
		const [end] = signalsOf(fake.reports(), "end");
		const [again] = signalsOf(fake.reports(), "status");
		expect(end?.details?.url).toBe(start?.details.url);
		expect(end?.startedAt).toBe(T);
		expect(again?.startedAt).toBe(T + 7_200_000);
		expect(mentions(again?.details.title, 2)).toBe(true);
	});
});

describe("拉取式直播状态(fetchLiveStatus)", () => {
	const A: { sourceKey: string; externalId: string } = {
		sourceKey: "fake-source",
		externalId: "person-a",
	};

	it("没开播:回 offline", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		expect(await fake.fetchLiveStatus(A)).toEqual({ ok: true, kind: "offline" });
	});

	it("开播之后:回 live,带开播时刻与这一场的内容;每按一次报直播状态,人数跟着涨", async () => {
		const fake = bootFakeSource([sub("person-a", true), sub("person-b", true)]);
		await fake.press("report.liveStart");
		const first = await fake.fetchLiveStatus(A);
		expect(first).toMatchObject({ ok: true, kind: "live", startedAt: T });
		if (!first.ok || first.kind !== "live") throw new Error("应该在播");
		expect(mentions(first.details.title, 1)).toBe(true);
		expect(first.details.cover).toMatch(IMAGE_REF_PATTERN);
		await fake.press("report.liveStatus");
		const second = await fake.fetchLiveStatus(A);
		if (!second.ok || second.kind !== "live") throw new Error("应该在播");
		expect(second.details.currentViewers).toBeGreaterThan(first.details.currentViewers ?? 0);
		expect(await fake.fetchLiveStatus({ ...A, externalId: "person-b" })).toMatchObject({
			kind: "live",
		});
	});

	it("下播之后:回 offline", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.liveStart");
		await fake.press("report.liveEnd");
		expect(await fake.fetchLiveStatus(A)).toEqual({ ok: true, kind: "offline" });
	});

	it("没被报过的人(停用的、外人)回 offline", async () => {
		const fake = bootFakeSource([sub("person-a", true), sub("person-c", false)]);
		await fake.press("report.liveStart");
		expect(await fake.fetchLiveStatus({ ...A, externalId: "person-c" })).toEqual({
			ok: true,
			kind: "offline",
		});
	});

	it("来源停了:回「来源没在跑」的失败,不抛", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.stop();
		expect(await fake.fetchLiveStatus(A)).toMatchObject({ ok: false, code: "unavailable" });
	});
});

describe("报资料", () => {
	it("名字带版次、粉丝数换一个、头像是图库里的 png 且远小于宿主那 8 MiB", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.profile");
		await fake.press("report.profile");
		const [p1, p2] = valuesOf<CreatorProfileReport>(fake.reports(), "profile");
		expect(mentions(p1?.name, 1)).toBe(true);
		expect(mentions(p2?.name, 2)).toBe(true);
		expect(isCount(p1?.followers)).toBe(true);
		expect(p2?.followers).not.toBe(p1?.followers);
		for (const p of [p1, p2]) {
			expect(p?.avatar).toMatch(IMAGE_REF_PATTERN);
			const bytes = fake.imageBytes(p?.avatar);
			expect(isPng(bytes)).toBe(true);
			expect(bytes?.byteLength).toBeLessThan(96 * 1024);
		}
	});

	/** 宿主只在摘要不同时才覆盖头像 —— 连按两下头像得真的不同,主人才看得见它换了。 */
	it("头像在四张里循环:相邻两下不同,第五下回到第一张", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		for (let i = 0; i < 5; i++) await fake.press("report.profile");
		const avatars = valuesOf<CreatorProfileReport>(fake.reports(), "profile").map((p) => p.avatar);
		expect(new Set(avatars.slice(0, 4)).size).toBe(4);
		expect(avatars[4]).toBe(avatars[0]);
	});

	/**
	 * 订阅是拿解析门候选的头像建的。报资料的头像要是与候选撞了同一张,宿主摘要一样不覆盖,主人按了第一下
	 * 看着像「头像没换」。
	 */
	it("报资料的头像与解析门候选的头像一张都不重样", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		const candidateAvatars = new Set<string>();
		for (const query of ["阿梓", "七海", "嘉然", "向晚", "乃琳", "贝拉"]) {
			for (const one of await fake.candidates(query)) {
				if (one.avatar) candidateAvatars.add(one.avatar);
			}
		}
		// 六句字、每句两张,四张候选头像全见过了 —— 下面那条「不重样」才不是空话。
		expect(candidateAvatars.size).toBe(4);
		for (let i = 0; i < 4; i++) await fake.press("report.profile");
		for (const profile of valuesOf<CreatorProfileReport>(fake.reports(), "profile")) {
			expect(candidateAvatars.has(profile.avatar as string)).toBe(false);
		}
	});

	it("两个人同一下拿到的名字不一样", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.press("report.profile");
		const names = valuesOf<CreatorProfileReport>(fake.reports(), "profile").map((p) => p.name);
		expect(names).toHaveLength(2);
		expect(names[0]).not.toBe(names[1]);
	});
});

describe("两颗报坏的", () => {
	it("带坏图的作品:三张图,第二张是个不合形状的引用,另外两张是图库里的 png", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.badImage");
		const [post] = valuesOf<PostReport>(fake.reports(), "post");
		const images = post?.post.images ?? [];
		expect(images).toHaveLength(3);
		expect(isPng(fake.imageBytes(images[0]))).toBe(true);
		expect(images[1]).toBe("not-a-ref");
		expect(images[1]).not.toMatch(IMAGE_REF_PATTERN);
		expect(isPng(fake.imageBytes(images[2]))).toBe(true);
	});

	/** 作品里宿主认的格(`ExtensionPostReportSchema` 的 `post`)。 */
	const POST_KEYS = [
		"creator",
		"publishedAt",
		"text",
		"richText",
		"images",
		"topic",
		"video",
		"stats",
	];

	it("多一格的作品:作品里多带一格宿主不认识的字段;上报没有返回值,动作照样成", async () => {
		const fake = bootFakeSource([sub("person-a", true)]);
		await fake.press("report.extraField");
		const [report] = valuesOf<PostReport>(fake.reports(), "post");
		const extra = Object.keys(report?.post ?? {}).filter((key) => !POST_KEYS.includes(key));
		expect(extra).toEqual(["danmaku"]);
	});
});

describe("可复现", () => {
	it("两个新起的假源按同样的顺序按,报出来的一模一样", async () => {
		const run = async () => {
			const fake = bootFakeSource(PEOPLE);
			for (const action of [
				"report.post",
				"report.liveStart",
				"report.liveStatus",
				"report.post",
				"report.profile",
				"report.liveEnd",
				"report.badImage",
			]) {
				await fake.press(action);
			}
			return fake.reports();
		};
		expect(await run()).toEqual(await run());
	});
});
