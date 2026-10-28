import { describe, expect, it } from "vite-plus/test";
import {
	creatorSearchHint,
	displayNameOf,
	sourceNounsOf,
	subscriptionIdentityLabel,
} from "../nouns";

describe("sourceNounsOf", () => {
	const neutral = { creatorNoun: "N-creator", postNoun: "N-post", sources: "N-sources" };

	it("一项、三格都声明时，原样给出", () => {
		expect(
			sourceNounsOf([{ label: "B 站", creatorNoun: "UP主", postNoun: "动态" }], neutral),
		).toEqual({
			creatorNoun: "UP主",
			postNoun: "动态",
			sources: "B 站",
		});
	});

	it("一项只声明作品叫法时，创作者落中性词", () => {
		expect(sourceNounsOf([{ label: "B 站", postNoun: "动态" }], neutral)).toEqual({
			creatorNoun: "N-creator",
			postNoun: "动态",
			sources: "B 站",
		});
	});

	it("一项的作品叫法是空白时，落中性词", () => {
		expect(sourceNounsOf([{ label: "B 站", postNoun: "  " }], neutral)).toEqual({
			creatorNoun: "N-creator",
			postNoun: "N-post",
			sources: "B 站",
		});
	});

	it("两项叫法不同时用中性词，来源名去重后用顿号连起来", () => {
		expect(
			sourceNounsOf(
				[
					{ label: "B 站", creatorNoun: "UP主", postNoun: "动态" },
					{ label: "B 站", creatorNoun: "博主", postNoun: "帖子" },
					{ label: "抖音", creatorNoun: "博主", postNoun: "视频" },
				],
				neutral,
			),
		).toEqual({ creatorNoun: "N-creator", postNoun: "N-post", sources: "B 站、抖音" });
	});

	it("零项时三格都落中性词", () => {
		expect(sourceNounsOf([], neutral)).toEqual({
			creatorNoun: "N-creator",
			postNoun: "N-post",
			sources: "N-sources",
		});
	});

	it("一项没有来源名时，来源落中性词", () => {
		expect(sourceNounsOf([{ creatorNoun: "UP主", postNoun: "动态" }], neutral)).toEqual({
			creatorNoun: "UP主",
			postNoun: "动态",
			sources: "N-sources",
		});
	});

	it("调用方换了中立词时，落中性的格跟着换", () => {
		expect(
			sourceNounsOf([{ label: "B 站" }], {
				creatorNoun: "Alt-creator",
				postNoun: "Alt-post",
				sources: "Alt-sources",
			}),
		).toEqual({
			creatorNoun: "Alt-creator",
			postNoun: "Alt-post",
			sources: "B 站",
		});
	});
});

describe("subscriptionIdentityLabel", () => {
	it("声明了外部 id 的叫法时，用它写标签", () => {
		expect(
			subscriptionIdentityLabel({ externalId: "123" }, { label: "B 站", externalIdNoun: "UID" }),
		).toBe("UID 123");
	});

	it("没声明外部 id 的叫法时，写平台名与外部 id", () => {
		expect(subscriptionIdentityLabel({ externalId: "abc" }, { label: "抖音" })).toBe("抖音 · abc");
	});

	it.each(["", "   "])("外部 id 的叫法是空白(%j)时，按没声明处理", (externalIdNoun) => {
		expect(
			subscriptionIdentityLabel({ externalId: "abc" }, { label: "抖音", externalIdNoun }),
		).toBe("抖音 · abc");
	});
});

describe("displayNameOf", () => {
	it("名字链先取事件名，再取资料名，最后才用身份标签", () => {
		expect(
			displayNameOf({ eventName: "事件里的名字", profileName: "资料里的名字" }, "UID 123"),
		).toBe("事件里的名字");
	});

	it("空串与只有空白的不算名字，一级一级退到身份标签", () => {
		expect(displayNameOf({ eventName: " ", profileName: "资料里的名字" }, "抖音 · abc")).toBe(
			"资料里的名字",
		);
		expect(displayNameOf({ eventName: "", profileName: "  " }, "抖音 · abc")).toBe("抖音 · abc");
	});
});

describe("creatorSearchHint", () => {
	/** 调用方按语言给的几样;拼法用一个看得出顺序的假列举。 */
	const words = {
		id: "W-id",
		link: "W-link",
		name: "W-name",
		creatorNoun: "W-creator",
		list: (parts: readonly string[]) => parts.join("|"),
		searchCreator: (creatorNoun: string) => `search ${creatorNoun}`,
	};

	it("按声明的先后拼几种输入;id 那一种用来源自己的外部 id 叫法", () => {
		expect(
			creatorSearchHint({ searchAccepts: ["id", "link", "name"], externalIdNoun: "UID" }, words),
		).toBe("UID|W-link|W-name");
		expect(creatorSearchHint({ searchAccepts: ["name", "id"] }, words)).toBe("W-name|W-id");
		expect(creatorSearchHint({ searchAccepts: ["link"], externalIdNoun: "  " }, words)).toBe(
			"W-link",
		);
	});

	it("没声明(或空表)→「搜索{creatorNoun}」:来源有叫法用它的,没有落中性词", () => {
		expect(creatorSearchHint({ creatorNoun: "主播" }, words)).toBe("search 主播");
		expect(creatorSearchHint({ searchAccepts: [], creatorNoun: " " }, words)).toBe(
			"search W-creator",
		);
	});
});
