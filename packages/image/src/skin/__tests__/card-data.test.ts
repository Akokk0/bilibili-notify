/**
 * 契约数据层(`skin/card-data.ts`)的四条钉子。
 *
 * 一、**对表**:七种卡各造一份「样样都有」的夹具,产出的字段路径集合必须与
 *    `CARD_SKIN_FIELDS[kind]` 一字不差(多一个 = 皮肤引用不到的死数据,少一个 = 皮肤写了
 *    取不到值),且每个值的 typeof 与字段表声明的 type 对得上(text / image → string)。
 * 二、**缺数据不炸**:再造一份「什么都没有」的夹具(可选字段全缺、作品卡的 node 上连视频
 *    与图都没有),每个字段仍有值 —— 没有 undefined,不会有 "undefined" 被替换进模板。
 * 三、**语义**:几条最容易在重构里被改掉的分支(直播卡的几种状态、封面、作品卡的几组字段
 *    都从 node 取、会员卡的档位各项、醒目留言的金额与档)。
 * 四、**取值**:`readCardField` 只认两段路径、只认自有属性,原型链上的名字一律取不到。
 */

import {
	CARD_KINDS,
	CARD_SKIN_FIELDS,
	type CardKind,
	type CardSkinFieldType,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { h } from "vue";
import { LIVE_COVER_PLACEHOLDER } from "../../live-view";
import type { LiveCardView } from "../../templates/live-card";
import type { MembershipCardView } from "../../templates/membership-card";
import type { PostCardView, PostNode } from "../../templates/post-card";
import type { RoastBoardCardInput, RoastSoloCardInput } from "../../templates/roast-card";
import type { SuperchatCardView } from "../../templates/superchat-card";
import type { WordCloudCardInput } from "../../templates/wordcloud-card";
import { buildCardData, type CardData, type CardDataValue, readCardField } from "../card-data";

// ── 夹具 ──────────────────────────────────────────────────────────────────────

function liveProps(over: Partial<LiveCardView> = {}): LiveCardView {
	return {
		status: "streaming",
		creatorName: "阿可",
		creatorAvatarUrl: "https://img/face.jpg",
		title: "今天也在打游戏",
		category: "虚拟主播",
		description: "简介第一行 第二行",
		cover: "https://img/cover.jpg",
		hasCover: true,
		time: "直播时长：1小时",
		currentViewers: "1.2万",
		likes: "3000",
		totalViewers: "5.4万",
		followers: "10.1万",
		followersDelta: "+123",
		...over,
	};
}

/** 什么都没有的直播卡:没在播,一格数据都没有。 */
function emptyLiveProps(): LiveCardView {
	return {
		status: "offline",
		creatorName: "",
		creatorAvatarUrl: "",
		title: "",
		category: "",
		description: "",
		cover: "",
		hasCover: false,
		time: "",
		currentViewers: "",
		likes: "",
		totalViewers: "",
		followers: "",
		followersDelta: "",
	};
}

function dynamicNode(over: Partial<PostNode> = {}): PostNode {
	return {
		creatorAvatarUrl: "https://img/up.jpg",
		creatorName: "某创作者",
		creatorIsPremium: true,
		time: "1 小时前",
		label: "投稿了视频",
		topic: "#今日话题#",
		attachment: h("div"),
		repost: {
			creatorAvatarUrl: "https://img/orig.jpg",
			creatorName: "原创作者",
			creatorIsPremium: false,
			time: "2 小时前",
			label: "发布了动态",
			isReposted: true,
		},
		stats: { shares: "12", comments: "34", likes: "5.6万" },
		...over,
	};
}

const FULL_PICS = [{ url: "https://img/pic1.jpg" }, { url: "https://img/pic2.jpg" }];

/** 投稿视频那张卡挂在 node 上的数据(`nodeFromPost` 的 `videoOf` 造出来的形状)。 */
const NODE_VIDEO = {
	cover: "https://img/video-cover.jpg",
	duration: "12:34",
	title: "这是一期视频",
	description: "",
	views: "6.5万",
	danmaku: "1024",
};

function dynamicProps(node: PostNode = dynamicNode()): PostCardView {
	return { node };
}

function scProps(over: Partial<SuperchatCardView> = {}): SuperchatCardView {
	return {
		viewerAvatarUrl: "https://img/sender.jpg",
		viewerName: "热心观众",
		creatorName: "阿可",
		creatorAvatarUrl: "https://img/master.jpg",
		text: "加油！",
		amount: "¥30",
		amountValue: 30,
		duration: "1分",
		rank: 1,
		bgColor: ["#a8e6cf", "#88d8b0"],
		...over,
	};
}

function emptySCProps(): SuperchatCardView {
	return {
		viewerAvatarUrl: "",
		viewerName: "",
		creatorName: "",
		text: "",
		amount: "",
		amountValue: 0,
		duration: "",
		rank: 0,
		bgColor: ["", ""],
	};
}

function guardProps(over: Partial<MembershipCardView> = {}): MembershipCardView {
	return {
		viewerAvatarUrl: "https://img/user.jpg",
		viewerName: "热心观众",
		creatorAvatarUrl: "https://img/master.jpg",
		creatorName: "阿可",
		tierName: "舰长",
		rank: 1,
		iconUrl: "https://img/captain.png",
		announcement: '"热心观众号"加入\n"阿可"大航海舰队！',
		bgColor: ["#4ebcec", "#4ebcec"],
		...over,
	};
}

function emptyGuardProps(): MembershipCardView {
	return {
		viewerAvatarUrl: "",
		viewerName: "",
		creatorAvatarUrl: "",
		creatorName: "",
		tierName: "",
		rank: 0,
		iconUrl: "",
		announcement: "",
		bgColor: ["", ""],
	};
}

const ROAST_UP = { name: "某创作者", avatar: "https://img/up.jpg", color: "#ff6699" };

function roastBoardProps(over: Partial<RoastBoardCardInput> = {}): RoastBoardCardInput {
	return {
		days: 7,
		pigeon: { ...ROAST_UP, reason: "又鸽了" },
		diligent: { ...ROAST_UP, reason: "很勤快" },
		roast: [{ ...ROAST_UP, comment: "锐评" }],
		scores: [{ ...ROAST_UP, score: 80 }],
		...over,
	};
}

function roastSoloProps(over: Partial<RoastSoloCardInput> = {}): RoastSoloCardInput {
	return {
		days: 30,
		creator: ROAST_UP,
		verdict: "还行",
		score: 60,
		highlights: [{ label: "勤奋", comment: "尚可" }],
		...over,
	};
}

function wordCloudProps(over: Partial<WordCloudCardInput> = {}): WordCloudCardInput {
	return {
		creatorName: "阿可",
		creatorAvatarUrl: "https://img/master.jpg",
		...over,
	};
}

/** 七种卡的「样样都有」夹具。 */
const FULL: Record<CardKind, () => CardData> = {
	live: () => buildCardData("live", liveProps()),
	post: () =>
		buildCardData("post", dynamicProps(dynamicNode({ video: NODE_VIDEO, images: FULL_PICS }))),
	superchat: () => buildCardData("superchat", scProps()),
	membership: () => buildCardData("membership", guardProps()),
	roastBoard: () => buildCardData("roastBoard", roastBoardProps()),
	roastSolo: () => buildCardData("roastSolo", roastSoloProps()),
	wordcloud: () => buildCardData("wordcloud", wordCloudProps()),
};

/** 七种卡的「什么都没有」夹具:可选字段全缺、作品卡的 node 上没有标签、视频与图。 */
const EMPTY: Record<CardKind, () => CardData> = {
	live: () => buildCardData("live", emptyLiveProps()),
	post: () =>
		buildCardData(
			"post",
			dynamicProps({
				creatorAvatarUrl: "",
				creatorName: "",
				creatorIsPremium: false,
				time: "",
			}),
		),
	superchat: () => buildCardData("superchat", emptySCProps()),
	membership: () => buildCardData("membership", emptyGuardProps()),
	roastBoard: () =>
		buildCardData("roastBoard", roastBoardProps({ days: 0, roast: [], scores: [] })),
	roastSolo: () =>
		buildCardData("roastSolo", roastSoloProps({ days: 0, creator: { name: "", color: "" } })),
	wordcloud: () => buildCardData("wordcloud", { creatorName: "" }),
};

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** 两层对象 → 「a.b」→ 值 的平表。 */
function flatten(data: CardData): Map<string, CardDataValue> {
	const out = new Map<string, CardDataValue>();
	for (const [group, bucket] of Object.entries(data)) {
		for (const [key, value] of Object.entries(bucket)) out.set(`${group}.${key}`, value);
	}
	return out;
}

const TYPEOF_OF: Record<CardSkinFieldType, string> = {
	text: "string",
	image: "string",
	number: "number",
	bool: "boolean",
};

// ── 一、对表 ──────────────────────────────────────────────────────────────────

describe("buildCardData 与 CARD_SKIN_FIELDS 对表", () => {
	for (const kind of CARD_KINDS) {
		it(`${kind} 卡的产出恰好覆盖契约字段,且类型对得上`, () => {
			const produced = flatten(FULL[kind]());
			const declared = CARD_SKIN_FIELDS[kind];

			expect([...produced.keys()].sort()).toEqual(declared.map((f) => f.path).sort());

			for (const field of declared) {
				expect(typeof produced.get(field.path), `${kind} 的 ${field.path}`).toBe(
					TYPEOF_OF[field.type],
				);
			}
		});
	}
});

// ── 二、缺数据不炸 ─────────────────────────────────────────────────────────────

/**
 * 空夹具下**不是**空值的字段:它的「没有」本来就有形状。列在这里是为了让它也被钉住,而不是从通用断言里漏出去。
 * 今天没有 —— 金额排好的字在视图里就是空串(㉓c 起金额由出卡入口经 `formatAmount` 排,不再是块里恒画的「¥ + 数字」)。
 */
const EMPTY_EXCEPTIONS: Record<string, CardDataValue> = {};

describe("缺数据时每个字段仍有值", () => {
	for (const kind of CARD_KINDS) {
		it(`${kind} 卡的空夹具不产生 undefined`, () => {
			const produced = flatten(EMPTY[kind]());
			const declared = CARD_SKIN_FIELDS[kind];

			expect([...produced.keys()].sort()).toEqual(declared.map((f) => f.path).sort());

			for (const field of declared) {
				const value = produced.get(field.path);
				const at = `${kind} 的 ${field.path}`;
				expect(value, at).not.toBeUndefined();
				expect(typeof value, at).toBe(TYPEOF_OF[field.type]);

				const exception = EMPTY_EXCEPTIONS[`${kind}:${field.path}`];
				if (exception !== undefined) {
					expect(value, at).toBe(exception);
					continue;
				}
				if (field.type === "text" || field.type === "image") expect(value, at).toBe("");
				if (field.type === "bool") expect(value, at).toBe(false);
				if (field.type === "number") expect(value, at).toBe(0);
			}
		});
	}
});

// ── 三、语义 ──────────────────────────────────────────────────────────────────

describe("直播卡的几种状态", () => {
	it("开播与直播中:isStreaming、在看人数、当前粉丝数(点赞与累计观看为空)", () => {
		for (const status of ["start", "streaming"] as const) {
			const d = buildCardData("live", liveProps({ status }));
			expect(d.live.isStreaming, status).toBe(true);
			expect(d.live.isEnded, status).toBe(false);
			expect(d.stats.currentViewers, status).toBe("1.2万");
			expect(d.stats.followers, status).toBe("10.1万");
			expect(d.stats.likes, status).toBe("");
			expect(d.stats.totalViewers, status).toBe("");
		}
	});

	/** 决策 76:下播卡画点赞与累计观看。验红:把 `likes` 改回恒取视图的点赞(下播以外也给值),或把下播的 `currentViewers` 改成有值。 */
	it("下播:isEnded、点赞、累计观看(在看人数与粉丝数为空)", () => {
		const d = buildCardData("live", liveProps({ status: "end" }));
		expect(d.live.isStreaming).toBe(false);
		expect(d.live.isEnded).toBe(true);
		expect(d.stats.likes).toBe("3000");
		expect(d.stats.totalViewers).toBe("5.4万");
		expect(d.stats.currentViewers).toBe("");
		expect(d.stats.followers).toBe("");
	});

	it("没在播:两个 is* 都为假,在看人数照给,别的三格为空", () => {
		const d = buildCardData("live", liveProps({ status: "offline" }));
		expect(d.live.isStreaming).toBe(false);
		expect(d.live.isEnded).toBe(false);
		expect(d.stats.currentViewers).toBe("1.2万");
		expect(d.stats.followers).toBe("");
		expect(d.stats.likes).toBe("");
		expect(d.stats.totalViewers).toBe("");
	});

	it("粉丝数变化哪种状态都照给(自己做皮肤的人想画就能画)", () => {
		for (const status of ["start", "streaming", "end", "offline"] as const) {
			const d = buildCardData("live", liveProps({ status }));
			expect(d.stats.followersDelta, status).toBe("+123");
			expect(d.stats.hasFollowersDelta, status).toBe(true);
		}
		expect(buildCardData("live", liveProps({ followersDelta: "" })).stats.hasFollowersDelta).toBe(
			false,
		);
	});
});

/**
 * 直播卡 `stats` 的四格各只装名字说的那一样:`currentViewers`(在看人数)、`likes`(下播后的点赞)、`followers`(粉丝数)、
 * `totalViewers`(下播后的累计观看),不该有值的状态下是空串。(㉔a 钉住的是拆分之前的现状:`stats.popularity` 下播取点赞、
 * 其余取在线人数;`stats.fans` 开播 / 直播中取粉丝数、下播取累计观看、没在播为空 —— ㉔b 拆成这四格。)
 * 四个来源格给**互不相同**的值,断言才分得出取的是哪一格;来源格为空串时也钉一遍。
 * 验红:把 `liveData` 里四格的三元条件任一个对调。
 */
describe("直播卡 stats 四格各状态取哪一格", () => {
	const SOURCES = { currentViewers: "ON", likes: "LK", totalViewers: "TV", followers: "FN" };

	it.each([
		// 状态,currentViewers,likes,followers,totalViewers
		["start", "ON", "", "FN", ""],
		["streaming", "ON", "", "FN", ""],
		["end", "", "LK", "", "TV"],
		["offline", "ON", "", "", ""],
	] as const)(
		"%s:currentViewers = %s,likes = %s,followers = %s,totalViewers = %s",
		(status, currentViewers, likes, followers, totalViewers) => {
			const d = buildCardData("live", liveProps({ status, ...SOURCES }));
			expect(d.stats).toMatchObject({ currentViewers, likes, followers, totalViewers });
		},
	);

	it("来源格是空串:下播没有点赞 / 累计观看 → 对应格空(不退回别的格);开播没有粉丝数 / 在看人数 → 对应格空", () => {
		const ended = buildCardData("live", liveProps({ status: "end", likes: "", totalViewers: "" }));
		expect(ended.stats.likes).toBe("");
		expect(ended.stats.totalViewers).toBe("");
		expect(
			buildCardData("live", liveProps({ status: "streaming", followers: "" })).stats.followers,
		).toBe("");
		expect(
			buildCardData("live", liveProps({ status: "streaming", currentViewers: "" })).stats
				.currentViewers,
		).toBe("");
	});

	it("没有 stats.area(分类只在 live.category)", () => {
		const d = buildCardData("live", liveProps({ category: "虚拟主播" }));
		expect("area" in d.stats).toBe(false);
		expect(d.live.category).toBe("虚拟主播");
	});
});

describe("直播卡的封面", () => {
	// 用哪一张(关键帧 / 房间封面 / 自定义封面)在出卡入口之前就定好了 —— B 站那头的翻译
	// (`liveCardInputFromRoomInfo`,`packages/live` 的 `live-card-input.test.ts` 钉着)与出卡入口
	// `generateLiveCard`(`__tests__/neutral-live-card.test.ts` 钉着)各管一段。契约说的就是
	// 视图里那张,与封面块画的是同一张。
	it("就是视图里生效的那张", () => {
		const d = buildCardData("live", liveProps());
		expect(d.live.cover).toBe("https://img/cover.jpg");
		expect(d.live.hasCover).toBe(true);
	});

	// 没有真封面时视图里已经是占位图(`buildLiveCardView` 定的,`neutral-live-card.test.ts`
	// 钉着);契约照视图说:`live.cover` 就是那张占位图,`live.hasCover` 如实为假。
	// 验红:把 `hasCover` 改回按「封面非空」判,这条红(占位图不是空串)。
	it("没有真封面 → cover 是视图里的占位图,hasCover 为假", () => {
		const d = buildCardData("live", liveProps({ cover: LIVE_COVER_PLACEHOLDER, hasCover: false }));
		expect(d.live.cover).toBe(LIVE_COVER_PLACEHOLDER);
		expect(d.live.hasCover).toBe(false);
	});
});

describe("作品卡的视频与图廊", () => {
	/**
	 * 两组都从 node 取(ADR-0019 决策 68):出卡入口只收 node,不再另收平台的原始数据。
	 * 验红:把 `post.hasVideo` / `images.*` 改回从别处取(或写死空值),这条红。
	 */
	it("视频、图廊两组都从 node 取", () => {
		const d = buildCardData(
			"post",
			dynamicProps(dynamicNode({ video: NODE_VIDEO, images: FULL_PICS })),
		);
		expect(d.post.hasVideo).toBe(true);
		expect(d.video.title).toBe("这是一期视频");
		expect(d.video.cover).toBe("https://img/video-cover.jpg");
		expect(d.video.duration).toBe("12:34");
		expect(d.video.views).toBe("6.5万");
		// 接口给的弹幕数可能是数字,契约里是 text。
		expect(d.video.danmaku).toBe("1024");
		expect(d.post.hasImages).toBe(true);
		expect(d.images.count).toBe(2);
		expect(d.images.first).toBe("https://img/pic1.jpg");
	});

	it("node 上没有视频与图:两组字段全空,两个 has* 为假,别的字段照常", () => {
		const d = buildCardData("post", dynamicProps());
		expect(d.post.hasVideo).toBe(false);
		expect(d.video.title).toBe("");
		expect(d.video.cover).toBe("");
		expect(d.post.hasImages).toBe(false);
		expect(d.images.count).toBe(0);
		expect(d.images.first).toBe("");
		// 别的几组不受这两组缺席影响。
		expect(d.creator.name).toBe("某创作者");
		expect(d.post.label).toBe("投稿了视频");
		expect(d.post.time).toBe("1 小时前");
		expect(d.post.hasRepost).toBe(true);
		expect(d.post.hasAttachment).toBe(true);
		expect(d.stats.likes).toBe("5.6万");
	});

	/**
	 * 🔴 「有没有视频」这一条,**块与契约必须同一个判据**。
	 *
	 * 块画的判据是 `node.video` 在不在(`blocks/post.tsx` 的五个视频块);契约这边从前
	 * 自己去 raw 里刨了一遍 archive,再拿「标题非空」当判据 —— 一条没标题的投稿于是画出了
	 * 封面,却告诉皮肤的 `showIf` 说没视频,皮肤要么摆出一块空的、要么把封面那格藏了。
	 *
	 * 验红:把 `hasVideo` 改回 `videoTitle !== ""`,这条红。
	 */
	it("标题是空的投稿:hasVideo 仍为真 —— 判据是有没有这张卡,不是有没有标题", () => {
		const d = buildCardData(
			"post",
			dynamicProps(dynamicNode({ video: { ...NODE_VIDEO, title: "" } })),
		);
		expect(d.post.hasVideo).toBe(true);
		expect(d.video.title).toBe("");
		expect(d.video.cover).toBe("https://img/video-cover.jpg");
	});

	it("不是视频作品:video 全空,图廊照取", () => {
		const d = buildCardData("post", dynamicProps(dynamicNode({ images: FULL_PICS })));
		expect(d.post.hasVideo).toBe(false);
		expect(d.video.duration).toBe("");
		expect(d.images.count).toBe(2);
	});
});

describe("会员卡的数据", () => {
	it("档位的各项原样取自视图:rank、档名、徽章、宣告语;观众与主播的头像也是视图里的地址", () => {
		const d = buildCardData("membership", guardProps());
		expect(d.membership).toEqual({
			rank: 1,
			tierName: "舰长",
			icon: "https://img/captain.png",
			announcement: '"热心观众号"加入\n"阿可"大航海舰队！',
		});
		expect(d.viewer).toEqual({ name: "热心观众", avatar: "https://img/user.jpg" });
		expect(d.creator).toEqual({ name: "阿可", avatar: "https://img/master.jpg" });
	});

	// 没有 rank 的体系(档位由主播自定的那种)交上来的档没有 `rank`:视图里是 0,字段就是 0 —— `rank` 本身从 1 起,
	// 所以 0 不会与真档混淆。数字类型的字段「缺了」都是 0(`num()`),不单为它开一个例外。
	it("没有 rank 的档 → membership.rank 是 0;没声明宣告语 → 空串;没有徽章 → 空串", () => {
		const d = buildCardData(
			"membership",
			guardProps({ rank: 0, announcement: "", iconUrl: "", tierName: "自定义档" }),
		);
		expect(d.membership).toEqual({ rank: 0, tierName: "自定义档", icon: "", announcement: "" });
	});

	it("rank 不是有限的数 → 0(契约里的数字永不是 NaN)", () => {
		expect(buildCardData("membership", guardProps({ rank: Number.NaN })).membership.rank).toBe(0);
	});
});

describe("醒目留言卡的数据", () => {
	it("金额是视图里排好的字、数字另给;rank 是夹进 1–6 的有效档位;时长是排好的字", () => {
		const d = buildCardData(
			"superchat",
			scProps({ amount: "US$30", amountValue: 30, rank: 4, duration: "30分" }),
		);
		expect(d.superchat).toEqual({
			amount: "US$30",
			amountValue: 30,
			duration: "30分",
			rank: 4,
			text: "加油！",
		});
		expect(typeof d.superchat.amountValue).toBe("number");
	});

	it("来源没给留言时长 → superchat.duration 是空串;观众头像没有 → viewer.avatar 是空串", () => {
		const d = buildCardData("superchat", scProps({ duration: "", viewerAvatarUrl: "" }));
		expect(d.superchat.duration).toBe("");
		expect(d.viewer.avatar).toBe("");
		expect(d.viewer.name).toBe("热心观众");
	});

	it("主播头像没给 → creator.avatar 是空串", () => {
		expect(
			buildCardData("superchat", scProps({ creatorAvatarUrl: undefined })).creator.avatar,
		).toBe("");
	});
});

// ── 四、取值 ──────────────────────────────────────────────────────────────────

describe("readCardField", () => {
	const data = buildCardData("live", liveProps());

	it("两段路径取得到值", () => {
		expect(readCardField(data, "creator.name")).toBe("阿可");
		expect(readCardField(data, "live.isStreaming")).toBe(true);
	});

	it("不存在的字段 / 不是两段的路径 → undefined", () => {
		expect(readCardField(data, "live.nope")).toBeUndefined();
		expect(readCardField(data, "nope.name")).toBeUndefined();
		expect(readCardField(data, "live")).toBeUndefined();
		expect(readCardField(data, "live.cover.extra")).toBeUndefined();
		expect(readCardField(data, "")).toBeUndefined();
	});

	it("原型链上的名字一律取不到", () => {
		// 没有这道门的话 constructor.name 是真取得到东西的 —— 先证明这一点,再证明它被挡住。
		expect((data as unknown as { constructor: { name: string } }).constructor.name).toBe("Object");

		expect(readCardField(data, "constructor.name")).toBeUndefined();
		expect(readCardField(data, "__proto__.constructor")).toBeUndefined();
		expect(readCardField(data, "creator.__proto__")).toBeUndefined();
		expect(readCardField(data, "creator.constructor")).toBeUndefined();
		expect(readCardField(data, "prototype.x")).toBeUndefined();
		expect(readCardField(data, "creator.toString")).toBeUndefined();
	});
});
