import type { DevScenario } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { mergeScenarios, type WebDevScenario } from "../registry";

/**
 * 两半合一份:服务端列出来的 + 浏览器里跑的,面板拿到的是一张表。守两条 —— 顺序稳定
 * (服务端在前,分组内保持声明顺序),以及**撞 id 直接炸**(两半共用一个命名空间,静默盖掉
 * 一个只会让「按了没反应」查不出来)。
 */

const server: DevScenario[] = [
	{ id: "update.state", group: "state", title: "更新状态", params: [] },
	{ id: "live.start", group: "event", title: "开播", params: [] },
];

const web: WebDevScenario[] = [
	{ id: "web.toast-flood", group: "web", title: "涌 toast", params: [], run: () => undefined },
];

describe("mergeScenarios", () => {
	it("服务端在前、前端在后,各自标明在哪一边跑", () => {
		expect(mergeScenarios(server, web)).toEqual([
			{ side: "server", decl: server[0] },
			{ side: "server", decl: server[1] },
			{ side: "web", decl: { id: "web.toast-flood", group: "web", title: "涌 toast", params: [] } },
		]);
	});

	it("撞 id 直接炸", () => {
		expect(() =>
			mergeScenarios(server, [{ ...web[0], id: "update.state" } as WebDevScenario]),
		).toThrow(/update\.state/);
	});
});
