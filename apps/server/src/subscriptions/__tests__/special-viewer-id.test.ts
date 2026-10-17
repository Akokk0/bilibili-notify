import { describe, expect, it } from "vite-plus/test";
import { specialViewerIdRefusal } from "../external-id.js";

const DIGITS = { label: "某站", externalIdRegex: "^\\d+$" };

/**
 * 特别关注名单上新加的观众 id,按这条订阅所属来源声明的格式核(3b-16,与新建订阅的外部 id 同一把尺子)。
 * 盘上已有的条目不回头核(迁移带过来的老条目可能不合格,不能因此让订阅改不了别的)。
 *
 * 验红:去掉「已在名单上的跳过」→ 「已有的不回头核」红;不传 `spec` 也核 → 「没声明格式」红。
 */
describe("specialViewerIdRefusal", () => {
	it("合格式的新条目放行", () => {
		expect(
			specialViewerIdRefusal(DIGITS, [{ id: "123", features: ["viewerChat"] }], []),
		).toBeUndefined();
	});

	it("不合格式的新条目 → invalid,issues 指到那一条的 id,话里点来源自己的名字", () => {
		const failure = specialViewerIdRefusal(
			DIGITS,
			[
				{ id: "1", features: ["viewerChat"] },
				{ id: "abc", features: ["viewerEnter"] },
			],
			[],
		);
		expect(failure).toMatchObject({
			ok: false,
			code: "invalid",
			issues: [{ path: ["specialViewers", 1, "id"], message: expect.any(String) }],
		});
		expect(failure?.message).toContain("某站");
	});

	it("已在名单上的条目不回头核(老的不合格也放行)", () => {
		expect(
			specialViewerIdRefusal(DIGITS, [{ id: "abc", features: ["viewerChat"] }], ["abc"]),
		).toBeUndefined();
	});

	it("没声明格式(或来源认不出):放行", () => {
		expect(specialViewerIdRefusal({ label: "甲" }, [{ id: "abc" }], [])).toBeUndefined();
		expect(specialViewerIdRefusal(undefined, [{ id: "abc" }], [])).toBeUndefined();
	});

	it("名单不是数组、条目不是对象:这里不管,留给 schema 报", () => {
		expect(specialViewerIdRefusal(DIGITS, undefined, [])).toBeUndefined();
		expect(specialViewerIdRefusal(DIGITS, "x", [])).toBeUndefined();
		expect(specialViewerIdRefusal(DIGITS, ["x", null, 5], [])).toBeUndefined();
	});
});

describe("specialViewerIdRefusal:回给面板的整句话", () => {
	it("观众 id 格式不对:整条失败的话与 issues 里的话,点名来源的 label", () => {
		expect(specialViewerIdRefusal(DIGITS, [{ id: "abc" }], [])).toMatchObject({
			message: "特别关注的观众 id 格式不对，要某站认的写法",
			issues: [{ message: "这个观众 id 不是某站认的写法" }],
		});
	});
});
