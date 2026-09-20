/**
 * 契约数据层(`skin/card-data.ts`)的四条钉子。
 *
 * 一、**对表**:七种卡各造一份「样样都有」的夹具,产出的字段路径集合必须与
 *    `CARD_SKIN_FIELDS[kind]` 一字不差(多一个 = 皮肤引用不到的死数据,少一个 = 皮肤写了
 *    取不到值),且每个值的 typeof 与字段表声明的 type 对得上(text / image → string)。
 * 二、**缺数据不炸**:再造一份「什么都没有」的夹具(可选字段全缺、动态卡连 raw 都没有),
 *    每个字段仍有值 —— 没有 undefined,不会有 "undefined" 被替换进模板。
 * 三、**语义**:几条最容易在重构里被改掉的分支(直播三态、封面四种来源、有无 raw、
 *    舰长四档、金额是数字)。
 * 四、**取值**:`readCardField` 只认两段路径、只认自有属性,原型链上的名字一律取不到。
 */

import { GuardLevel } from "@bilibili-notify/blive";
import {
	CARD_SKIN_FIELDS,
	CARD_SKIN_KINDS,
	type CardSkinFieldType,
	type CardSkinKind,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { h } from "vue";
import { getSCLevel, SC_COLORS } from "../../styles";
import type { DynamicCardProps, DynamicNode } from "../../templates/dynamic-card";
import type { GuardCardProps } from "../../templates/guard-card";
import type { LiveCardProps } from "../../templates/live-card";
import type { RoastBoardCardProps, RoastSoloCardProps } from "../../templates/roast-card";
import type { SCCardProps } from "../../templates/sc-card";
import type { WordCloudCardProps } from "../../templates/wordcloud-card";
import type { Dynamic } from "../../types";
import { buildCardData, type CardData, type CardDataValue, readCardField } from "../card-data";

// ── 夹具 ──────────────────────────────────────────────────────────────────────

function liveProps(over: Partial<LiveCardProps> = {}): LiveCardProps {
	return {
		data: {
			title: "今天也在打游戏",
			area_name: "虚拟主播",
			description: "<p>简介第一行<br>第二行</p>",
			user_cover: "https://img/user_cover.jpg",
			keyframe: "https://img/keyframe.jpg",
		},
		username: "阿可",
		userface: "https://img/face.jpg",
		titleStatus: "",
		liveTime: "已开播 1 小时",
		liveStatus: 1,
		cover: true,
		coverOverride: "https://img/override.jpg",
		onlineNum: "1.2万",
		likedNum: "3000",
		watchedNum: "5.4万",
		fansNum: "10.1万",
		fansChanged: "+123",
		...over,
	};
}

/** 什么都没有的直播卡:接口只回了个空壳,开关全关。 */
function emptyLiveProps(): LiveCardProps {
	return {
		data: {},
		username: "",
		userface: "",
		titleStatus: "",
		liveTime: "",
		liveStatus: 0,
		cover: false,
		onlineNum: "",
		likedNum: "",
		watchedNum: "",
		fansNum: "",
		fansChanged: "",
	};
}

function dynamicNode(over: Partial<DynamicNode> = {}): DynamicNode {
	return {
		avatarUrl: "https://img/up.jpg",
		upName: "某 UP 主",
		upIsVip: true,
		pubTime: "1 小时前",
		headerLabel: "投稿了视频",
		topic: "#今日话题#",
		additional: h("div"),
		forward: {
			avatarUrl: "https://img/orig.jpg",
			upName: "原 UP 主",
			upIsVip: false,
			pubTime: "2 小时前",
		},
		stats: { forward: "12", comment: "34", like: "5.6万" },
		...over,
	};
}

/**
 * 原始动态夹具。真实结构又深又全(module_author 十几个必填字段),这里只捏映射层真正会读
 * 的那几支 —— 读到别的字段就会在这条断言里当场炸,正是想要的。
 */
function rawDynamic(major: unknown, type = "DYNAMIC_TYPE_AV"): Dynamic {
	return { type, modules: { module_dynamic: { major } } } as unknown as Dynamic;
}

const FULL_ARCHIVE = {
	badge: { text: "投稿视频" },
	cover: "https://img/video-cover.jpg",
	duration_text: "12:34",
	title: "这是一期视频",
	desc: "",
	stat: { play: "6.5万", danmaku: 1024 },
	bvid: "BV1xx411c7mD",
	jump_url: "",
};

const FULL_PICS = [{ url: "https://img/pic1.jpg" }, { url: "https://img/pic2.jpg" }];

/** `buildDynamicNode` 从 {@link FULL_ARCHIVE} 抽出来挂在 node 上的那一份(见 `videoOf`)。 */
const NODE_VIDEO = {
	cover: "https://img/video-cover.jpg",
	duration: "12:34",
	title: "这是一期视频",
	desc: "",
	views: "6.5万",
	danmaku: "1024",
};

function dynamicProps(node: DynamicNode = dynamicNode()): DynamicCardProps {
	return { node };
}

function scProps(over: Partial<SCCardProps> = {}): SCCardProps {
	return {
		senderFace: "https://img/sender.jpg",
		senderName: "热心观众",
		masterName: "阿可",
		masterAvatarUrl: "https://img/master.jpg",
		text: "加油！",
		price: 30,
		duration: "60秒",
		bgColor: SC_COLORS[0],
		...over,
	};
}

function emptySCProps(): SCCardProps {
	return {
		senderFace: "",
		senderName: "",
		masterName: "",
		text: "",
		price: 0,
		duration: "",
		bgColor: ["", ""],
	};
}

function guardProps(over: Partial<GuardCardProps> = {}): GuardCardProps {
	return {
		captainImgUrl: "https://img/captain.png",
		guardLevel: GuardLevel.Captain,
		uname: "热心观众",
		face: "https://img/user.jpg",
		isAdmin: 1,
		masterAvatarUrl: "https://img/master.jpg",
		masterName: "阿可",
		bgColor: ["#4ebcec", "#b494e5"],
		...over,
	};
}

function emptyGuardProps(): GuardCardProps {
	return {
		captainImgUrl: "",
		guardLevel: GuardLevel.None,
		uname: "",
		face: "",
		isAdmin: 0,
		masterAvatarUrl: "",
		masterName: "",
		bgColor: ["", ""],
	};
}

const ROAST_UP = { name: "某 UP 主", avatar: "https://img/up.jpg", color: "#ff6699" };

function roastBoardProps(over: Partial<RoastBoardCardProps> = {}): RoastBoardCardProps {
	return {
		days: 7,
		pigeon: { ...ROAST_UP, reason: "又鸽了" },
		diligent: { ...ROAST_UP, reason: "很勤快" },
		roast: [{ ...ROAST_UP, comment: "锐评" }],
		scores: [{ ...ROAST_UP, score: 80 }],
		...over,
	};
}

function roastSoloProps(over: Partial<RoastSoloCardProps> = {}): RoastSoloCardProps {
	return {
		days: 30,
		up: ROAST_UP,
		verdict: "还行",
		score: 60,
		highlights: [{ label: "勤奋", comment: "尚可" }],
		...over,
	};
}

function wordCloudProps(over: Partial<WordCloudCardProps> = {}): WordCloudCardProps {
	return {
		masterName: "阿可",
		masterAvatarUrl: "https://img/master.jpg",
		...over,
	};
}

/** 七种卡的「样样都有」夹具。 */
const FULL: Record<CardSkinKind, () => CardData> = {
	live: () => buildCardData("live", liveProps()),
	dynamic: () =>
		buildCardData(
			"dynamic",
			dynamicProps(),
			rawDynamic({ type: "MAJOR_TYPE_ARCHIVE", archive: FULL_ARCHIVE, opus: { pics: FULL_PICS } }),
		),
	sc: () => buildCardData("sc", scProps()),
	guard: () => buildCardData("guard", guardProps()),
	roastBoard: () => buildCardData("roastBoard", roastBoardProps()),
	roastSolo: () => buildCardData("roastSolo", roastSoloProps()),
	wordcloud: () => buildCardData("wordcloud", wordCloudProps()),
};

/** 七种卡的「什么都没有」夹具:可选字段全缺、动态卡连 raw 都不给。 */
const EMPTY: Record<CardSkinKind, () => CardData> = {
	live: () => buildCardData("live", emptyLiveProps()),
	dynamic: () =>
		buildCardData(
			"dynamic",
			dynamicProps({
				avatarUrl: "",
				upName: "",
				upIsVip: false,
				pubTime: "",
			}),
		),
	sc: () => buildCardData("sc", emptySCProps()),
	guard: () => buildCardData("guard", emptyGuardProps()),
	roastBoard: () =>
		buildCardData("roastBoard", roastBoardProps({ days: 0, roast: [], scores: [] })),
	roastSolo: () =>
		buildCardData("roastSolo", roastSoloProps({ days: 0, up: { name: "", color: "" } })),
	wordcloud: () => buildCardData("wordcloud", { masterName: "" }),
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
	for (const kind of CARD_SKIN_KINDS) {
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
 * 空夹具下**不是**空值的字段:它的「没有」本来就有形状 —— 金额块恒画「¥ + 数字」。
 * 列在这里是为了让它也被钉住,而不是从通用断言里漏出去。
 */
const EMPTY_EXCEPTIONS: Record<string, CardDataValue> = {
	"sc:sc.price": "¥0",
};

describe("缺数据时每个字段仍有值", () => {
	for (const kind of CARD_SKIN_KINDS) {
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

describe("直播卡的三态", () => {
	it("直播中:isStreaming、人气、当前粉丝数", () => {
		const d = buildCardData("live", liveProps({ liveStatus: 1 }));
		expect(d.live.isStreaming).toBe(true);
		expect(d.live.isEnded).toBe(false);
		expect(d.stats.popularity).toBe("1.2万");
		expect(d.stats.fans).toBe("10.1万");
	});

	it("已下播:isEnded、累计观看;接口没给数(哨兵值 API)时为空", () => {
		const d = buildCardData("live", liveProps({ liveStatus: 2 }));
		expect(d.live.isStreaming).toBe(false);
		expect(d.live.isEnded).toBe(true);
		expect(d.stats.fans).toBe("5.4万");

		const noData = buildCardData("live", liveProps({ liveStatus: 2, watchedNum: "API" }));
		expect(noData.stats.fans).toBe("");
	});

	it("刚下播(3):两个 is* 都为假,人气位换成点赞、粉丝位换成粉丝变化", () => {
		const d = buildCardData("live", liveProps({ liveStatus: 3 }));
		expect(d.live.isStreaming).toBe(false);
		expect(d.live.isEnded).toBe(false);
		expect(d.stats.popularity).toBe("3000");
		expect(d.stats.fans).toBe("+123");
		expect(d.stats.fansChanged).toBe("+123");
		expect(d.stats.hasFansChanged).toBe(true);
	});
});

describe("直播卡封面的几种来源", () => {
	const data = (over: Record<string, unknown>) => ({
		title: "",
		area_name: "",
		description: "",
		...over,
	});

	// 与 `blocks/live.tsx` 封面块同一条选择逻辑:自定义封面优先;否则 `cover` 为真取
	// 房间封面、为假取关键帧。契约说「有封面」就得是画出来的那张。
	it("自定义封面优先,不看 cover 开关", () => {
		for (const cover of [true, false]) {
			const d = buildCardData("live", liveProps({ cover }));
			expect(d.live.cover).toBe("https://img/override.jpg");
			expect(d.live.hasCover).toBe(true);
		}
	});

	it("cover 为真取房间封面", () => {
		const d = buildCardData("live", liveProps({ cover: true, coverOverride: undefined }));
		expect(d.live.cover).toBe("https://img/user_cover.jpg");
	});

	it("cover 为假取关键帧(直播中那张)", () => {
		const d = buildCardData(
			"live",
			liveProps({
				cover: false,
				coverOverride: undefined,
				data: data({ keyframe: "https://img/keyframe.jpg" }),
			}),
		);
		expect(d.live.cover).toBe("https://img/keyframe.jpg");
		expect(d.live.hasCover).toBe(true);
	});

	it("该取的那张没有 → 空串且 hasCover 为假,不去偷另一张", () => {
		const d = buildCardData(
			"live",
			liveProps({
				cover: true,
				coverOverride: undefined,
				data: data({ keyframe: "https://img/keyframe.jpg" }),
			}),
		);
		expect(d.live.cover).toBe("");
		expect(d.live.hasCover).toBe(false);
	});

	it("简介剥成纯文本", () => {
		const d = buildCardData("live", liveProps());
		expect(d.live.description).not.toContain("<");
		expect(d.live.description).toContain("简介第一行");
	});
});

describe("动态卡的视频与图廊", () => {
	it("视频那一组从 node 取、图廊那一组从原始动态取", () => {
		const d = buildCardData(
			"dynamic",
			dynamicProps(dynamicNode({ video: NODE_VIDEO })),
			rawDynamic({ archive: FULL_ARCHIVE, opus: { pics: FULL_PICS } }),
		);
		expect(d.dynamic.type).toBe("DYNAMIC_TYPE_AV");
		expect(d.dynamic.hasVideo).toBe(true);
		expect(d.video.title).toBe("这是一期视频");
		expect(d.video.cover).toBe("https://img/video-cover.jpg");
		expect(d.video.duration).toBe("12:34");
		expect(d.video.views).toBe("6.5万");
		// 接口给的弹幕数可能是数字,契约里是 text。
		expect(d.video.danmaku).toBe("1024");
		expect(d.dynamic.hasPics).toBe(true);
		expect(d.pics.count).toBe(2);
		expect(d.pics.first).toBe("https://img/pic1.jpg");
	});

	it("没有 raw、node 上也没有视频:两组字段全空,两个 has* 为假,node 那边的字段照常", () => {
		const d = buildCardData("dynamic", dynamicProps());
		expect(d.dynamic.type).toBe("");
		expect(d.dynamic.hasVideo).toBe(false);
		expect(d.video.title).toBe("");
		expect(d.video.cover).toBe("");
		expect(d.dynamic.hasPics).toBe(false);
		expect(d.pics.count).toBe(0);
		expect(d.pics.first).toBe("");
		// node 给的那几组不受 raw 缺席影响。
		expect(d.up.name).toBe("某 UP 主");
		expect(d.dynamic.action).toBe("投稿了视频");
		expect(d.dynamic.isForward).toBe(true);
		expect(d.stats.like).toBe("5.6万");
	});

	/**
	 * 🔴 「有没有视频」这一条,**块与契约必须同一个判据**。
	 *
	 * 块画的判据是 `node.video` 在不在(`blocks/dynamic.tsx` 的五个视频块);契约这边从前
	 * 自己去 raw 里刨了一遍 archive,再拿「标题非空」当判据 —— 一条没标题的投稿于是画出了
	 * 封面,却告诉皮肤的 `showIf` 说没视频,皮肤要么摆出一块空的、要么把封面那格藏了。
	 *
	 * 验红:把 `hasVideo` 改回 `videoTitle !== ""`(或让 video 那一组回去读 raw),这条红。
	 */
	it("标题是空的投稿:hasVideo 仍为真 —— 判据是有没有这张卡,不是有没有标题", () => {
		const d = buildCardData(
			"dynamic",
			dynamicProps(dynamicNode({ video: { ...NODE_VIDEO, title: "" } })),
			rawDynamic({ archive: { ...FULL_ARCHIVE, title: "" } }),
		);
		expect(d.dynamic.hasVideo).toBe(true);
		expect(d.video.title).toBe("");
		expect(d.video.cover).toBe("https://img/video-cover.jpg");
	});

	it("有 raw 但不是视频动态:video 全空,图廊照取", () => {
		const d = buildCardData(
			"dynamic",
			dynamicProps(),
			rawDynamic({ opus: { pics: FULL_PICS } }, "DYNAMIC_TYPE_DRAW"),
		);
		expect(d.dynamic.type).toBe("DYNAMIC_TYPE_DRAW");
		expect(d.dynamic.hasVideo).toBe(false);
		expect(d.video.duration).toBe("");
		expect(d.pics.count).toBe(2);
	});
});

describe("上舰卡的四档", () => {
	it.each([
		[GuardLevel.Governor, "总督"],
		[GuardLevel.Admiral, "提督"],
		[GuardLevel.Captain, "舰长"],
		[GuardLevel.None, ""],
	])("guardLevel=%s → levelName=%s", (level, name) => {
		const d = buildCardData("guard", guardProps({ guardLevel: level }));
		expect(d.guard.level).toBe(level);
		expect(d.guard.levelName).toBe(name);
	});

	it("文字信息那句带上用户名与主播名;0 档没有这句", () => {
		const d = buildCardData("guard", guardProps({ guardLevel: GuardLevel.Governor }));
		expect(d.guard.text).toContain("热心观众");
		expect(d.guard.text).toContain("阿可");
		expect(d.guard.text).toContain("总督");
		expect(buildCardData("guard", guardProps({ guardLevel: GuardLevel.None })).guard.text).toBe("");
	});

	it("房管标记是布尔", () => {
		expect(buildCardData("guard", guardProps({ isAdmin: 1 })).user.isAdmin).toBe(true);
		expect(buildCardData("guard", guardProps({ isAdmin: 0 })).user.isAdmin).toBe(false);
	});
});

describe("SC 卡的金额", () => {
	it("price 带货币符号、priceValue 是数字、level 按渲染器同一条公式从金额算", () => {
		const d = buildCardData("sc", scProps({ price: 30, bgColor: SC_COLORS[0] }));
		expect(d.sc.price).toBe("¥30");
		expect(d.sc.priceValue).toBe(30);
		expect(typeof d.sc.priceValue).toBe("number");
		expect(d.sc.level).toBe(getSCLevel(300));
	});

	it("高价位落在最高档,与 bgColor 传什么无关", () => {
		const d = buildCardData("sc", scProps({ price: 2000, bgColor: SC_COLORS[0] }));
		expect(d.sc.price).toBe("¥2000");
		expect(d.sc.level).toBe(5);
	});
});

// ── 四、取值 ──────────────────────────────────────────────────────────────────

describe("readCardField", () => {
	const data = buildCardData("live", liveProps());

	it("两段路径取得到值", () => {
		expect(readCardField(data, "up.name")).toBe("阿可");
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
		expect(readCardField(data, "up.__proto__")).toBeUndefined();
		expect(readCardField(data, "up.constructor")).toBeUndefined();
		expect(readCardField(data, "prototype.x")).toBeUndefined();
		expect(readCardField(data, "up.toString")).toBeUndefined();
	});
});
