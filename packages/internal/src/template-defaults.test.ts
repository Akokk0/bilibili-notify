/**
 * 「默认文案有更新」的亮灯判定。
 *
 * 主人改了某条模板的默认文案,已经装好的用户拿不到 —— 他们盘上写的是**当初那一版**。
 * 此前靠 `store.ts` 里一张手写的「历代旧默认」表来认「这人没改过」,可那张表跟当前
 * 默认分居两个包,改默认时没有任何东西提醒你去补一条。`liveSummary` 就这么漏过一次。
 *
 * 换个思路:不再判断「他改没改过」,只判断「**这一版默认他见过没有**」。见过就闭嘴,
 * 没见过且他的值确实和当前默认不一样,就亮个灯让他自己决定。于是历代表整张作废。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	allTemplateFingerprints,
	pendingTemplateUpdates,
	templateDefaultAt,
	templateFingerprint,
} from "./template-defaults";

describe("pendingTemplateUpdates", () => {
	it("老配置没有 seen、盘上还是旧默认 → 亮灯", () => {
		// 这就是主人要解的那件事:改了默认,已装好的用户得知道。
		expect(pendingTemplateUpdates({ liveStart: "旧文案" }, { liveStart: "新文案" }, {})).toEqual([
			"liveStart",
		]);
	});

	it("嵌套的 guardBuy 三档文案也算模板,按点路径报出来", () => {
		// 上舰三档的文案藏在 guardBuy 底下,而它们确实是主人会改默认的东西
		// (`store.ts` 那张旧迁移表里就专门有 OLD_GUARD 一节)。只扫顶层会漏掉它们。
		expect(
			pendingTemplateUpdates(
				{ guardBuy: { enable: false, captain: { imageUrl: "", template: "旧的舰长文案" } } },
				{ guardBuy: { enable: false, captain: { imageUrl: "", template: "新的舰长文案" } } },
				{},
			),
		).toEqual(["guardBuy.captain.template"]);
	});

	it("这一版默认已经见过 → 闭嘴", () => {
		// 主人手写过自己的文案,他的值**永远**不等于默认。若只看「值不一样」就亮灯,
		// 这灯从此不灭,他会学会无视它 —— 等真有要紧的更新时也一样看不见。
		// 所以判据是「**这一版**默认他见过没有」,见过就不再打扰。
		expect(
			pendingTemplateUpdates(
				{ liveStart: "我自己写的" },
				{ liveStart: "新文案" },
				{ liveStart: templateFingerprint("新文案") },
			),
		).toEqual([]);
	});

	it("值已经等于当前默认 → 不亮灯,哪怕没见过这版指纹", () => {
		// 这条挡的是「某字段默认从没变过」的老用户:他的 seen 是空的(新字段),
		// 但值句句等于默认,没有任何可更新的东西。少了这个条件他会满屏亮灯。
		expect(pendingTemplateUpdates({ liveStart: "同一句" }, { liveStart: "同一句" }, {})).toEqual(
			[],
		);
	});

	it("处理过上一版、主人又改了默认 → 重新亮灯", () => {
		// 提示不是一次性的:主人每改一次默认,该问的还得再问一次。
		expect(
			pendingTemplateUpdates(
				{ liveStart: "我自己写的" },
				{ liveStart: "第三版文案" },
				{ liveStart: templateFingerprint("第二版文案") }, // 他只见过第二版
			),
		).toEqual(["liveStart"]);
	});

	it("多条同时有更新 → 一条不落全报出来", () => {
		expect(
			pendingTemplateUpdates(
				{ liveStart: "旧一", liveEnd: "旧二", dynamic: "没变" },
				{ liveStart: "新一", liveEnd: "新二", dynamic: "没变" },
				{},
			),
		).toEqual(["liveStart", "liveEnd"]);
	});
});

describe("templateDefaultAt", () => {
	it("顺着点路径取出那条默认文案 —— 界面要拿它做预览、也拿它写值", () => {
		const defaults = { guardBuy: { captain: { template: "舰长文案" } } };
		expect(templateDefaultAt(defaults, "guardBuy.captain.template")).toBe("舰长文案");
	});

	it("路径不存在 → undefined,不是抛错", () => {
		expect(templateDefaultAt({ liveStart: "x" }, "guardBuy.captain.template")).toBeUndefined();
	});
});

describe("templateFingerprint", () => {
	it("内容变了指纹就变 —— 这是整套判定的地基", () => {
		expect(templateFingerprint("开播啦")).not.toBe(templateFingerprint("开播啦!"));
	});

	it("同一份内容指纹稳定 —— 否则每次启动都会误判成「默认变了」", () => {
		expect(templateFingerprint("开播啦")).toBe(templateFingerprint("开播啦"));
	});
});

describe("allTemplateFingerprints", () => {
	it("把每条文案的当前指纹按点路径列全 —— 主人改默认后新装的用户不该看见「有更新」", () => {
		expect(
			allTemplateFingerprints({
				liveStart: "开播啦",
				guardBuy: { enable: false, captain: { template: "舰长文案" } },
			}),
		).toEqual({
			liveStart: templateFingerprint("开播啦"),
			"guardBuy.captain.template": templateFingerprint("舰长文案"),
		});
	});
});
