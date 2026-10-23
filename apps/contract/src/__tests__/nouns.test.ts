import { describe, expect, it } from "vite-plus/test";
import { displayNameOf, subscriptionIdentityLabel } from "../nouns";

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
