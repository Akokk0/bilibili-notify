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
	ExtensionBlock,
	ExtensionOwnSubscription,
	ExtensionRichText,
	ExtensionView,
} from "@bilibili-notify/extension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bootFakeSource, type HeardKind, type HeardReport } from "./harness.js";

const T = Date.UTC(2026, 8, 23, 12);

beforeEach(() => {
	// 只假 Date:时刻要钉死才比得了「可复现」,定时器与 Promise 照走真的。
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T);
});
afterEach(() => {
	vi.useRealTimers();
});

function sub(id: number, externalId: string, enabled: boolean): ExtensionOwnSubscription {
	return { id: `00000000-0000-4000-8000-00000000000${id}`, externalId, enabled };
}

/** 甲两条开着的(推给两组群)、乙一条开着的、丙一条停用的。 */
const PEOPLE = [
	sub(1, "person-a", true),
	sub(2, "person-a", true),
	sub(3, "person-b", true),
	sub(4, "person-c", false),
];

/** 清单里声明的动作名。 */
async function manifestActions(): Promise<string[]> {
	const manifest = JSON.parse(
		await readFile(new URL("../../extension.json", import.meta.url), "utf8"),
	) as { actions?: string[] };
	return manifest.actions ?? [];
}

type Post = {
	id: string;
	url: string;
	publishedAt: number;
	text?: string;
	images?: Uint8Array[];
	video?: {
		cover?: Uint8Array;
		title?: string;
		duration?: number;
		description?: string;
		plays?: number;
	};
	stats?: { likes?: number; comments?: number; shares?: number };
};
type Live = {
	live?: boolean;
	url?: string;
	startedAt?: number;
	title?: string;
	cover?: Uint8Array;
	category?: string;
	viewers?: number;
	likes?: number;
	description?: string;
};
type Profile = { name?: string; avatar?: Uint8Array; fans?: number };

function valuesOf<T>(reports: readonly HeardReport[], kind: HeardKind): T[] {
	return reports.filter((r) => r.kind === kind).map((r) => r.value as T);
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
		const fake = bootFakeSource([sub(4, "person-c", false)]);
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

	it("宿主拒了一条正常的:动作失败,原话带到面板", async () => {
		const fake = bootFakeSource(PEOPLE, { refuse: () => "链接不对" });
		await expect(fake.press("report.post")).rejects.toThrow(/链接不对/);
	});

	it("交进来时 signal 已经中止(超时 / 拓展停用):一条都不报,按它的 reason 拒掉", async () => {
		const fake = bootFakeSource(PEOPLE);
		const controller = new AbortController();
		const reason = new DOMException("拓展 fake-source 停用了", "AbortError");
		controller.abort(reason);
		await expect(fake.press("report.post", controller.signal)).rejects.toBe(reason);
		expect(fake.reports()).toEqual([]);
	});
});

describe("报一条作品", () => {
	it("单数是图文(正文 + 三张 png + 互动数),双数是视频(封面 png、标题、时长、简介、播放数 + 互动数)", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.post");
		await fake.press("report.post");
		const [first, second] = valuesOf<Post>(fake.reports(), "post");

		expect(first?.publishedAt).toBe(T);
		expect(first?.text).toEqual(expect.any(String));
		expect(first?.images).toHaveLength(3);
		expect(first?.images?.every(isPng)).toBe(true);
		expect(first?.video).toBeUndefined();

		expect(second?.images).toBeUndefined();
		expect(isPng(second?.video?.cover)).toBe(true);
		expect(mentions(second?.video?.title, 2)).toBe(true);
		expect(second?.video?.duration).toBeGreaterThan(0);
		expect(second?.video?.description).toEqual(expect.any(String));
		expect(isCount(second?.video?.plays)).toBe(true);

		for (const post of [first, second]) {
			expect(isCount(post?.stats?.likes)).toBe(true);
			expect(isCount(post?.stats?.comments)).toBe(true);
			expect(isCount(post?.stats?.shares)).toBe(true);
			expect(isHarmlessUrl(post?.url)).toBe(true);
		}
	});

	it("作品 id、链接、正文都带序号,一下一个;两个人同一下拿到的 id 不撞", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.press("report.post");
		await fake.press("report.post");
		const posts = valuesOf<Post>(fake.reports(), "post");
		expect(posts).toHaveLength(4);
		const [a1, b1, a2] = posts;
		for (const [post, n] of [
			[a1, 1],
			[b1, 1],
			[a2, 2],
		] as const) {
			expect(mentions(post?.id, n), post?.id).toBe(true);
			expect(mentions(post?.url, n), post?.url).toBe(true);
			expect(mentions(post?.text, n), post?.text).toBe(true);
		}
		expect(new Set(posts.map((p) => p.id)).size).toBe(4);
	});

	it("没有开着的订阅时按的那一下不占序号", async () => {
		const fake = bootFakeSource([]);
		await fake.press("report.post");
		fake.changeSubscriptions([sub(1, "person-a", true)]);
		await fake.press("report.post");
		const [post] = valuesOf<Post>(fake.reports(), "post");
		expect(mentions(post?.id, 1)).toBe(true);
	});
});

describe("开播 / 报直播状态 / 下播", () => {
	it("开播:链接、开播时刻、带场次的标题、封面 png、分区、人数、点赞、简介都填上", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.liveStart");
		const [start] = valuesOf<Live>(fake.reports(), "liveStart");
		expect(isHarmlessUrl(start?.url)).toBe(true);
		expect(start?.startedAt).toBe(T);
		expect(mentions(start?.title, 1)).toBe(true);
		expect(isPng(start?.cover)).toBe(true);
		expect(start?.category).toEqual(expect.any(String));
		expect(start?.viewers).toBeGreaterThan(0);
		expect(isCount(start?.likes)).toBe(true);
		expect(start?.description).toEqual(expect.any(String));
	});

	it("报直播状态:报「在播」,人数每按一次往上涨;开播时刻沿用开播那一刻,链接同一个", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.liveStart");
		vi.setSystemTime(T + 60_000);
		await fake.press("report.liveStatus");
		vi.setSystemTime(T + 120_000);
		await fake.press("report.liveStatus");
		const [start] = valuesOf<Live>(fake.reports(), "liveStart");
		const [s1, s2] = valuesOf<Live>(fake.reports(), "liveStatus");
		expect([s1?.live, s2?.live]).toEqual([true, true]);
		expect(s1?.viewers).toBeGreaterThan(start?.viewers ?? Number.POSITIVE_INFINITY);
		expect(s2?.viewers).toBeGreaterThan(s1?.viewers ?? Number.POSITIVE_INFINITY);
		expect([s1?.startedAt, s2?.startedAt]).toEqual([T, T]);
		expect([s1?.url, s2?.url]).toEqual([start?.url, start?.url]);
		expect(mentions(s2?.title, 1)).toBe(true);
	});

	/**
	 * 不同的动作宿主不挡着并发(决策 42 只挡同一个)。开播还在一个个报的时候按了报直播状态,后面那几个人的
	 * 开播不该沾上涨过的人数 —— 每一下报的是按下那一刻的样子。
	 */
	it("开播报到一半按了报直播状态:同一下开播,每个人拿到的人数一样", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding = true;
		const fake = bootFakeSource(PEOPLE, {
			hold: (report) => {
				if (!holding || report.kind !== "liveStart") return undefined;
				holding = false;
				return held;
			},
		});
		const starting = fake.press("report.liveStart");
		await fake.press("report.liveStatus");
		release();
		await starting;
		const viewers = valuesOf<Live>(fake.reports(), "liveStart").map((v) => v.viewers);
		expect(viewers).toHaveLength(2);
		expect(viewers[1]).toBe(viewers[0]);
	});

	it("没开播就报直播状态(演 BN 重启过、开播没见着):照样报在播,从这一刻算起", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.liveStatus");
		const [status] = valuesOf<Live>(fake.reports(), "liveStatus");
		expect(status?.live).toBe(true);
		expect(status?.startedAt).toBe(T);
		expect(status?.viewers).toBeGreaterThan(0);
	});

	it("下播:补上开播时刻;之后再报直播状态是新的一场", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.liveStart");
		vi.setSystemTime(T + 3_600_000);
		await fake.press("report.liveEnd");
		vi.setSystemTime(T + 7_200_000);
		await fake.press("report.liveStatus");
		const [start] = valuesOf<Live>(fake.reports(), "liveStart");
		const [end] = valuesOf<Live>(fake.reports(), "liveEnd");
		const [again] = valuesOf<Live>(fake.reports(), "liveStatus");
		expect(end?.url).toBe(start?.url);
		expect(end?.startedAt).toBe(T);
		expect(again?.startedAt).toBe(T + 7_200_000);
		expect(mentions(again?.title, 2)).toBe(true);
	});
});

describe("报资料", () => {
	it("名字带版次、粉丝数换一个、头像是 png 且远小于宿主那 96 KiB", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.profile");
		await fake.press("report.profile");
		const [p1, p2] = valuesOf<Profile>(fake.reports(), "profile");
		expect(mentions(p1?.name, 1)).toBe(true);
		expect(mentions(p2?.name, 2)).toBe(true);
		expect(isCount(p1?.fans)).toBe(true);
		expect(p2?.fans).not.toBe(p1?.fans);
		for (const p of [p1, p2]) {
			expect(isPng(p?.avatar)).toBe(true);
			expect(p?.avatar?.byteLength).toBeLessThan(96 * 1024);
		}
	});

	/** 宿主只在摘要不同时才覆盖头像 —— 连按两下头像得真的不同,主人才看得见它换了。 */
	it("头像在四张里循环:相邻两下不同,第五下回到第一张", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		for (let i = 0; i < 5; i++) await fake.press("report.profile");
		const avatars = valuesOf<Profile>(fake.reports(), "profile").map((p) =>
			Buffer.from(p.avatar ?? []).toString("hex"),
		);
		expect(new Set(avatars.slice(0, 4)).size).toBe(4);
		expect(avatars[4]).toBe(avatars[0]);
	});

	/**
	 * 订阅是拿解析门候选的头像建的。报资料的头像要是与候选撞了同一张,宿主摘要一样不覆盖,主人按了第一下
	 * 看着像「头像没换」。
	 */
	it("报资料的头像与解析门候选的头像一张都不重样", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		const candidateAvatars = new Set<string>();
		for (const query of ["阿梓", "七海", "嘉然", "向晚", "乃琳", "贝拉"]) {
			for (const one of await fake.lookup(query)) {
				if (one.avatar) candidateAvatars.add(one.avatar.slice(one.avatar.indexOf(",") + 1));
			}
		}
		// 六句字、每句两张,四张候选头像全见过了 —— 下面那条「不重样」才不是空话。
		expect(candidateAvatars.size).toBe(4);
		for (let i = 0; i < 4; i++) await fake.press("report.profile");
		for (const profile of valuesOf<Profile>(fake.reports(), "profile")) {
			expect(candidateAvatars.has(Buffer.from(profile.avatar ?? []).toString("base64"))).toBe(
				false,
			);
		}
	});

	it("两个人同一下拿到的名字不一样", async () => {
		const fake = bootFakeSource(PEOPLE);
		await fake.press("report.profile");
		const names = valuesOf<Profile>(fake.reports(), "profile").map((p) => p.name);
		expect(names).toHaveLength(2);
		expect(names[0]).not.toBe(names[1]);
	});
});

describe("两颗报坏的", () => {
	it("带坏图的作品:三张图,第二张是 SVG,另外两张是 png", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await fake.press("report.badImage");
		const [post] = valuesOf<Post>(fake.reports(), "post");
		expect(post?.images).toHaveLength(3);
		expect(isPng(post?.images?.[0])).toBe(true);
		expect(new TextDecoder().decode(post?.images?.[1]).startsWith("<svg")).toBe(true);
		expect(isPng(post?.images?.[2])).toBe(true);
	});

	/** 作品那张表认的格,抄自契约 `SubscriptionPost`。 */
	const POST_KEYS = ["id", "url", "publishedAt", "text", "images", "video", "stats", "author"];

	it("多一格的作品:多带一格作品表里没有的字段;宿主整条拒是意料之中,动作不算失败", async () => {
		let refused: HeardReport | undefined;
		const fake = bootFakeSource([sub(1, "person-a", true)], {
			refuse: (report) => {
				refused = report;
				return "BN 不认识这几格";
			},
		});
		await fake.press("report.extraField");
		expect(refused?.kind).toBe("post");
		const extra = Object.keys(refused?.value as object).filter((key) => !POST_KEYS.includes(key));
		expect(extra).toHaveLength(1);
	});

	it("多一格的作品宿主竟然收下了:动作失败,说 BN 本该整条拒 —— 那是 BN 的毛病,别让它静悄悄过去", async () => {
		const fake = bootFakeSource([sub(1, "person-a", true)]);
		await expect(fake.press("report.extraField")).rejects.toThrow(/整条拒/);
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
