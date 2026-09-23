/**
 * 写不进去的时候那一发怎么念成一句话(`/api/ext/:id/settings`,ADR-0019 决策 35)。
 *
 * 值得钉的:校验不过的 400 里,`path` 从设置那一层数、列表项**按 id** 点名 —— 落在这一格列表上的
 * 说成「哪一条的哪一格」(按 id 找,不按第几条数:增删之后下标会挪),落在别处的照路径说;409 说
 * 「被改过了」;不是那份 400 的、拆不出一条的,原话照搬 —— 失败的原因不许吞。
 */

import type { ExtensionListField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "../../../../services/api";
import {
	CONFLICT_TEXT,
	dialogIssuesOf,
	type ListItem,
	settingsIssuesOf,
	settingsValuesOf,
	writeFailureOf,
	writeReasonOf,
} from "../list-items";

const LINKS: ExtensionListField = {
	key: "links",
	type: "list",
	label: "桥接入",
	itemLabel: "接入",
	title: "name",
	fields: [
		{ key: "name", type: "string", label: "名字", required: true },
		{ key: "token", type: "string", label: "token", secret: true, generate: true },
	],
};

const ITEMS: ListItem[] = [
	{ id: "c1", name: "家里那台" },
	{ id: "c2", name: "" },
];

/** 一份 400:`issues` 原样放进响应体。 */
function invalid(issues: unknown): ApiError {
	return new ApiError(
		400,
		{ error: "validation_failed", message: "不合规矩", issues },
		"PATCH /api/ext/bridge/settings → 400",
	);
}

const failureOf = (err: unknown) => writeFailureOf(err, LINKS, ITEMS);

describe("writeFailureOf", () => {
	it("落在列表某一项的某一格:按 id 点名那一条(有标题说标题)与那一格", () => {
		expect(failureOf(invalid([{ op: 0, path: ["links", "c1", "name"], message: "太长了" }]))).toBe(
			"「家里那台」的 名字:太长了",
		);
	});

	it("那一条没标题 / 不在屏幕上的名单里(刚新建的、已经删了的):说「这条接入」", () => {
		expect(
			failureOf(
				invalid([
					{ path: ["links", "c2", "token"], message: "要 32 位" },
					{ op: 0, path: ["links", "4f1c-新的"], message: "这个列表里没有这一项" },
				]),
			),
		).toBe("这条接入的 token:要 32 位;这条接入:这个列表里没有这一项");
	});

	it("那一格清单里没有:只点名那一条", () => {
		expect(failureOf(invalid([{ path: ["links", "c1", "ghost"], message: "不认识" }]))).toBe(
			"「家里那台」:不认识",
		);
	});

	it("落在整格列表上:说这一格的名字", () => {
		expect(failureOf(invalid([{ path: ["links"], message: "最多十条" }]))).toBe("桥接入:最多十条");
	});

	it("这个拓展设置里别的格:照路径说;没路径就只说那句话", () => {
		expect(
			failureOf(
				invalid([
					{ path: ["cookie", "a"], message: "必填" },
					{ path: [], message: "整份不对" },
					{ message: "没带路径" },
				]),
			),
		).toBe("cookie.a:必填;整份不对;没带路径");
	});

	it("一条认不出来的 issue 照样占一句,话是「不合规矩」", () => {
		expect(failureOf(invalid([null, { path: ["links"], message: 3 }]))).toBe(
			"不合规矩;桥接入:不合规矩",
		);
	});

	it("409:说被改过了 —— 不照搬服务端那句「重新读一遍再改」(面板已经重读了)", () => {
		const conflict = new ApiError(
			409,
			{ error: "revision_conflict", message: "重新读一遍再改", revision: "r2" },
			"重新读一遍再改",
		);
		expect(failureOf(conflict)).toBe(CONFLICT_TEXT);
		expect(CONFLICT_TEXT).toContain("设置在你打开之后被改过了");
	});

	it("拆不出一条的(issues 空 / 不是数组 / 别的 400):原话照搬", () => {
		expect(failureOf(invalid([]))).toBe("PATCH /api/ext/bridge/settings → 400");
		expect(failureOf(invalid("坏了"))).toBe("PATCH /api/ext/bridge/settings → 400");
		expect(failureOf(new ApiError(400, { err: "只读盘" }, "只读盘"))).toBe("只读盘");
		expect(failureOf(new ApiError(0, undefined, "连接中断"))).toBe("连接中断");
		expect(failureOf(new Error("配置目录是只读的"))).toBe("配置目录是只读的");
	});
});

describe("writeReasonOf", () => {
	it("不分给哪一格时:照路径一条条说;409 说被改过了;别的原话", () => {
		expect(
			writeReasonOf(
				invalid([
					{ path: ["links", "c1", "name"], message: "太长了" },
					{ path: ["interval"], message: "太小了" },
				]),
			),
		).toBe("links.c1.name:太长了;interval:太小了");
		expect(writeReasonOf(new ApiError(409, {}, "x"))).toBe(CONFLICT_TEXT);
		expect(writeReasonOf(new Error("断网了"))).toBe("断网了");
	});
});

describe("dialogIssuesOf", () => {
	/**
	 * 弹窗那一发只有一步:`["links", <哪一项>, <哪一格>]` 里的那一格就是弹窗里的那一格 —— 新建那一项
	 * 的 id 是服务端现生成的、面板不认识,不按它判。
	 */
	it("落得到弹窗里某一格的放那一格(同一格留第一句),落不到的整条说", () => {
		expect(
			dialogIssuesOf(
				invalid([
					{ op: 0, path: ["links", "新生成的", "name"], message: "名字重了" },
					{ op: 0, path: ["links", "新生成的", "name"], message: "第二句" },
					{ op: 0, path: ["links", "新生成的", "token"], message: "不在弹窗里" },
					{ path: ["links"], message: "最多十条" },
				]),
				LINKS,
				new Set(["name"]),
				ITEMS,
			),
		).toEqual({
			byField: { name: "名字重了" },
			rest: ["这条接入的 token:不在弹窗里", "桥接入:最多十条"],
		});
	});

	it("不是那份 400 的:null(弹窗说原话)", () => {
		expect(dialogIssuesOf(new Error("断网了"), LINKS, new Set(["name"]), ITEMS)).toBeNull();
	});
});

describe("settingsIssuesOf", () => {
	it("路径原样(从设置那一层数)、带着第几步;认不出的段丢掉", () => {
		expect(
			settingsIssuesOf(
				invalid([
					{ op: 1, path: ["links", "c1", "name"], message: "太长了" },
					{ path: ["cookie", { weird: true }], message: "必填" },
				]),
			),
		).toEqual([
			{ op: 1, path: ["links", "c1", "name"], message: "太长了", text: "links.c1.name:太长了" },
			{ op: undefined, path: ["cookie"], message: "必填", text: "cookie:必填" },
		]);
	});

	it("只认面板的 ApiError:长得像的(带着 body)不拆", () => {
		const lookalike = Object.assign(new Error("400"), {
			status: 400,
			body: { error: "validation_failed", issues: [{ path: [], message: "x" }] },
		});
		expect(settingsIssuesOf(lookalike)).toBeNull();
	});
});

describe("settingsValuesOf", () => {
	it("读到了:交出 values", () => {
		const values = { links: [], note: "x" };
		expect(settingsValuesOf({ revision: "r1", values })).toBe(values);
	});

	it("还没读到 / values 不是对象:当它是空的", () => {
		expect(settingsValuesOf(undefined)).toEqual({});
		for (const values of [undefined, null, "x", 3, ["a"]]) {
			expect(
				settingsValuesOf({ revision: "r1", values } as unknown as Parameters<
					typeof settingsValuesOf
				>[0]),
			).toEqual({});
		}
	});
});
