/**
 * 单元测试 —— `atAllOptsForDynamicKind`:决定一次 broadcastDynamic 是否抑制 @全体。
 *
 * 回归契约:一条 DYNAMIC_TYPE_DRAW 图文动态会发两次推送 —— 主卡片(kind="dynamic")
 * 与图集附图(kind="dynamic-images")。两者都映射到 feature="dynamic",若都进 @全体
 * 分支就会**重复艾特全体**(用户报告的 bug)。图集是主卡片的附属,不应再次 @全体。
 */

import { describe, expect, it } from "vite-plus/test";
import { atAllOptsForDynamicKind } from "../push-like.js";

describe("atAllOptsForDynamicKind", () => {
	it("主卡片(dynamic)→ 不抑制(undefined),维持按 feature 决定的 @全体", () => {
		expect(atAllOptsForDynamicKind("dynamic")).toBeUndefined();
	});

	it("图集附图(dynamic-images)→ 抑制 @全体,避免与主卡片重复艾特", () => {
		expect(atAllOptsForDynamicKind("dynamic-images")).toEqual({ allowAtAll: false });
	});
});
