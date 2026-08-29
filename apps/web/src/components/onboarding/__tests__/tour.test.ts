/**
 * 导览(带我做)的判据跟随逻辑与脚本完整性。
 *
 * 形态定案(2026-08-29 二轮,主人拍板):控件级粒度 + 左下角伴随悬浮窗 +
 * 判据驱动为主 —— 主步(login/subs/adapter/target/graduate)的切换由机器判据
 * 驱动(activeKey 变了自动跳到新主步的第一个子步),主步内的子步才是手动翻页。
 *
 * 钉住:
 * - activeKey 变化(前进或回退)→ 位置跟随并重置子步;没变 → 保持手动子步位置;
 * - 全绿(activeKey=null)→ 进入 done 祝贺态;
 * - 脚本完整性:五个主步都有子步、每个子步 route 都是站内路由、锚点在词表内。
 */

import { describe, expect, it } from "vite-plus/test";
import { reconcileTourPos, TOUR_ANCHORS, TOUR_SCRIPT } from "../tour-script";

describe("reconcileTourPos 判据跟随", () => {
	it("初始(无位置)→ 落在当前 activeKey 的第一个子步", () => {
		expect(reconcileTourPos(null, "login")).toEqual({ stepKey: "login", subIndex: 0 });
	});

	it("判据前进(login 完成 → activeKey=subs)→ 自动切到 subs 第一子步", () => {
		expect(reconcileTourPos({ stepKey: "login", subIndex: 0 }, "subs")).toEqual({
			stepKey: "subs",
			subIndex: 0,
		});
	});

	it("判据回退(target 被禁用 → activeKey 退回 target)同样跟随", () => {
		expect(reconcileTourPos({ stepKey: "graduate", subIndex: 0 }, "target")).toEqual({
			stepKey: "target",
			subIndex: 0,
		});
	});

	it("activeKey 未变 → 保持手动子步位置", () => {
		expect(reconcileTourPos({ stepKey: "adapter", subIndex: 2 }, "adapter")).toEqual({
			stepKey: "adapter",
			subIndex: 2,
		});
	});

	it("子步越界(脚本改短了)→ 收回最后一个子步", () => {
		const max = TOUR_SCRIPT.adapter.length - 1;
		expect(reconcileTourPos({ stepKey: "adapter", subIndex: 99 }, "adapter")).toEqual({
			stepKey: "adapter",
			subIndex: max,
		});
	});

	it("全绿(activeKey=null)→ done 祝贺态", () => {
		expect(reconcileTourPos({ stepKey: "graduate", subIndex: 0 }, null)).toEqual({
			stepKey: "done",
			subIndex: 0,
		});
	});
});

describe("TOUR_SCRIPT 脚本完整性", () => {
	it("五个主步都有至少一个子步", () => {
		for (const key of ["login", "subs", "adapter", "target", "graduate"] as const) {
			expect(TOUR_SCRIPT[key].length).toBeGreaterThan(0);
		}
	});

	it("每个子步的 route 是站内绝对路径,锚点(如有)在词表内", () => {
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				expect(sub.route.startsWith("/")).toBe(true);
				if (sub.anchor) expect(TOUR_ANCHORS).toContain(sub.anchor);
			}
		}
	});
});

describe("锚点与页面挂点不脱节", () => {
	it("词表里每个锚点都真实挂在某个页面源码上", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const pagesDir = resolve(__dirname, "../../../pages");
		const sources = ["System.tsx", "Subs.tsx", "Targets.tsx"]
			.map((f) => readFileSync(resolve(pagesDir, f), "utf8"))
			.join("\n");
		for (const anchor of TOUR_ANCHORS) {
			// 挂点被重构删掉时这条会红 —— 导览会静默失去高亮,只有这里拦得住。
			expect(sources, `data-tour="${anchor}" 不在任何页面上`).toContain(`data-tour="${anchor}"`);
		}
	});
});
