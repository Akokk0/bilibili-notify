/**
 * 服务端照清单校验不过时那份 400(`{ error: "validation_failed", issues }`)怎么念成一句话。
 *
 * 值得钉的:落在这一格列表上的点名是哪一条的哪一格(按**这一发**发出去的名单数),落在别处的
 * 照路径说;不是那份 400 的、拆不出一条的,原话照搬 —— 失败的原因不许吞。
 */

import type { ExtensionListField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "../../../../services/api";
import type { GlobalConfig } from "../../../../types/globals";
import {
	extensionSettingsOf,
	type ListItem,
	settingsIssuesOf,
	writeFailureOf,
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

const SENT: ListItem[] = [
	{ id: "c1", name: "家里那台" },
	{ id: "c2", name: "" },
];

/** 一份 400:`issues` 原样放进响应体。 */
function invalid(issues: unknown): ApiError {
	return new ApiError(
		400,
		{ error: "validation_failed", scope: "globals", issues },
		"PATCH /api/globals → 400",
	);
}

const failureOf = (err: unknown) => writeFailureOf(err, "bridge", LINKS, SENT);

describe("writeFailureOf", () => {
	it("落在列表某一项的某一格:点名那一条(有标题说标题)与那一格", () => {
		expect(
			failureOf(
				invalid([
					{ path: ["extensions", "bridge", "settings", "links", 0, "name"], message: "太长了" },
				]),
			),
		).toBe("「家里那台」的 名字:太长了");
	});

	it("那一条没标题 / 不在这一发的名单里:说第几条", () => {
		expect(
			failureOf(
				invalid([
					{ path: ["extensions", "bridge", "settings", "links", 1, "token"], message: "要 32 位" },
					{ path: ["extensions", "bridge", "settings", "links", 5], message: "少了 id" },
				]),
			),
		).toBe("第 2 条接入的 token:要 32 位;第 6 条接入:少了 id");
	});

	it("那一格清单里没有:只点名那一条", () => {
		expect(
			failureOf(
				invalid([
					{ path: ["extensions", "bridge", "settings", "links", 0, "ghost"], message: "不认识" },
				]),
			),
		).toBe("「家里那台」:不认识");
	});

	it("落在整格列表上:说这一格的名字", () => {
		expect(
			failureOf(
				invalid([{ path: ["extensions", "bridge", "settings", "links"], message: "要是数组" }]),
			),
		).toBe("桥接入:要是数组");
	});

	it("这个拓展设置里别的格:从设置那一层往下照路径说", () => {
		expect(
			failureOf(
				invalid([{ path: ["extensions", "bridge", "settings", "cookie", "a"], message: "必填" }]),
			),
		).toBe("cookie.a:必填");
	});

	it("别的拓展 / 设置之外:整条路径照说;没路径就只说那句话", () => {
		expect(
			failureOf(
				invalid([
					{ path: ["extensions", "douyin", "settings", "links", 0], message: "别人的" },
					{ path: ["extensions", "bridge", "enabled"], message: "要是布尔" },
					{ path: [], message: "整份不对" },
					{ message: "没带路径" },
				]),
			),
		).toBe(
			"extensions.douyin.settings.links.0:别人的;extensions.bridge.enabled:要是布尔;整份不对;没带路径",
		);
	});

	it("一条认不出来的 issue 照样占一句,话是「不合规矩」", () => {
		expect(
			failureOf(
				invalid([null, { path: ["extensions", "bridge", "settings", "links"], message: 3 }]),
			),
		).toBe("不合规矩;桥接入:不合规矩");
	});

	it("拆不出一条的(issues 空 / 不是数组 / 别的 400):原话照搬", () => {
		expect(failureOf(invalid([]))).toBe("PATCH /api/globals → 400");
		expect(failureOf(invalid("坏了"))).toBe("PATCH /api/globals → 400");
		expect(failureOf(new ApiError(400, { err: "只读盘" }, "只读盘"))).toBe("只读盘");
		expect(failureOf(new ApiError(0, undefined, "连接中断"))).toBe("连接中断");
		expect(failureOf(new Error("配置目录是只读的"))).toBe("配置目录是只读的");
	});
});

describe("settingsIssuesOf", () => {
	it("落在这个拓展设置里的:哪一格、那一格往下的路径;落在别处的两样都没有", () => {
		expect(
			settingsIssuesOf(
				invalid([
					{ path: ["extensions", "bridge", "settings", "links", 0, "name"], message: "太长了" },
					{ path: ["extensions", "douyin", "settings", "note"], message: "别人的" },
				]),
				"bridge",
			),
		).toEqual([
			{ key: "links", subPath: [0, "name"], message: "太长了", text: "links.0.name:太长了" },
			{
				key: undefined,
				subPath: [],
				message: "别人的",
				text: "extensions.douyin.settings.note:别人的",
			},
		]);
	});

	it("只认面板的 ApiError:长得像的(带着 body)不拆", () => {
		const lookalike = Object.assign(new Error("400"), {
			status: 400,
			body: { error: "validation_failed", issues: [{ path: [], message: "x" }] },
		});
		expect(settingsIssuesOf(lookalike, "bridge")).toBeNull();
	});
});

describe("extensionSettingsOf", () => {
	const globalsWith = (extensions: unknown) => ({ extensions }) as unknown as GlobalConfig;

	it("存着的是对象:原样交出", () => {
		const settings = { links: [], note: "x" };
		expect(
			extensionSettingsOf(globalsWith({ bridge: { enabled: true, settings } }), "bridge"),
		).toBe(settings);
	});

	it("没读到 / 没存过 / 不是对象:当它是空的", () => {
		expect(extensionSettingsOf(undefined, "bridge")).toEqual({});
		expect(extensionSettingsOf(globalsWith(undefined), "bridge")).toEqual({});
		expect(extensionSettingsOf(globalsWith({}), "bridge")).toEqual({});
		for (const settings of [undefined, null, "x", 3, ["a"]]) {
			expect(
				extensionSettingsOf(globalsWith({ bridge: { enabled: true, settings } }), "bridge"),
			).toEqual({});
		}
	});
});
