/**
 * 导览(带我做)的判据跟随逻辑与脚本完整性。
 *
 * 形态定案(2026-08-29 二轮,主人拍板):控件级粒度 + 左下角伴随悬浮窗 +
 * 判据驱动为主 —— 主步(login/adapter/target/test/subs,五轮定稿顺序:先打通
 * 推送通道再订阅)的切换由机器判据驱动(activeKey 变了自动跳到新主步的第一个
 * 子步),主步内的子步才是手动翻页。
 *
 * 钉住:
 * - 判据**前进与回退都跟随**:回退=前置被破坏(退出登录/删适配器),导览带
 *   用户回去补 —— 曾做成「只进不退」,真机退出登录后卡在适配器步、登录被
 *   略过(2026-08-29 主人纠正)。「不回头」只约束交互层:没有「上一步」按钮;
 * - activeKey 没变 → 保持手动子步位置;
 * - 脚本完整性:五个主步都有子步、每个子步 route 都是站内路由、锚点在词表内、
 *   说明步(advanceOnRoute)不配锚点(它在目标页面上一帧都不停留)。
 */

import { describe, expect, it } from "vite-plus/test";
import { listSources } from "../../../__tests__/walk";
import { MODAL_ONLY_ANCHORS, reconcileTourPos, TOUR_ANCHORS, TOUR_SCRIPT } from "../tour-script";

describe("reconcileTourPos 判据跟随", () => {
	it("初始(无位置)→ 落在当前 activeKey 的第一个子步", () => {
		expect(reconcileTourPos(null, "login")).toEqual({ stepKey: "login", subIndex: 0 });
	});

	it("判据前进(login 完成 → activeKey=adapter)→ 自动切到 adapter 第一子步", () => {
		expect(reconcileTourPos({ stepKey: "login", subIndex: 0 }, "adapter")).toEqual({
			stepKey: "adapter",
			subIndex: 0,
		});
	});

	it("判据回退(前置被破坏,如退出登录)→ 跟随回去补,不卡在做不了的后续步", () => {
		expect(reconcileTourPos({ stepKey: "adapter", subIndex: 1 }, "login")).toEqual({
			stepKey: "login",
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
		expect(reconcileTourPos({ stepKey: "subs", subIndex: 0 }, null)).toEqual({
			stepKey: "done",
			subIndex: 0,
		});
	});
});

describe("TOUR_SCRIPT 脚本完整性", () => {
	it("五个主步都有至少一个子步", () => {
		for (const key of ["login", "adapter", "target", "test", "subs"] as const) {
			expect(TOUR_SCRIPT[key].length).toBeGreaterThan(0);
		}
	});

	it("每个子步的 route 是站内绝对路径,锚点(单值或链)在词表内,link(如有)也指站内", () => {
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				expect(sub.route.startsWith("/")).toBe(true);
				const chain = Array.isArray(sub.anchor) ? sub.anchor : sub.anchor ? [sub.anchor] : [];
				for (const anchor of chain) expect(TOUR_ANCHORS).toContain(anchor);
				for (const anchor of (sub.anchorOnFail ?? []).flat()) {
					expect(TOUR_ANCHORS).toContain(anchor);
				}
				if (sub.link) expect(sub.link.to.startsWith("/")).toBe(true);
				// 说明步抵达即流转,在目标页一帧都不停 —— 配 anchor 只会闪一下灯,纯 bug
				if (sub.advanceOnRoute) expect(sub.anchor).toBeUndefined();
			}
		}
	});

	it("失败链:表单锚点在链头(过弹窗即复原靠它),「配置」与「测试」同亮成组(锁着也两个动作都可点)", () => {
		const cases = [
			{
				sub: TOUR_SCRIPT.adapter.at(-1),
				form: "adapter-form",
				cfg: "adapter-config",
				test: "adapter-test",
			},
			{ sub: TOUR_SCRIPT.test[0], form: "target-form", cfg: "target-config", test: "target-test" },
		] as const;
		for (const { sub, form, cfg, test } of cases) {
			const chain = sub?.anchorOnFail ?? [];
			expect(chain[0], "链头必须是弹窗内的表单锚点,否则点「配置」再取消灯就失踪").toBe(form);
			const group = chain.find((e) => Array.isArray(e) && e.includes(cfg));
			expect(
				group,
				"「配置」必须和「测试」结成同亮组 —— 引导锁不放开,两个动作都得在洞内",
			).toContain(test);
		}
	});

	it("锚点链不能只有弹窗内挂点 —— 弹窗没开时灯必须有页面级目标可指(subs 步栽过)", () => {
		// 「哪些挂点只住在弹窗里」这条事实住在词表旁边(MODAL_ONLY_ANCHORS),
		// 不在这里抄一份 —— 抄的那份漏标一个不会红,只会悄悄放行一条永不亮的链。
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				const chains = [
					Array.isArray(sub.anchor) ? sub.anchor : sub.anchor ? [sub.anchor] : [],
					(sub.anchorOnFail ?? []).flat(),
				];
				for (const chain of chains) {
					if (chain.length === 0) continue;
					expect(
						chain.some((a) => !MODAL_ONLY_ANCHORS.has(a)),
						`「${sub.title}」的锚点链全在弹窗里,弹窗没开时灯永不亮`,
					).toBe(true);
				}
			}
		}
	});
});

describe("锚点与页面挂点不脱节", () => {
	it("每个子步 route 都有顶栏页签可聚(off-route 指路的前提;「带我去」已退役)", async () => {
		const { NAV_ITEMS } = await import("../../../config/nav");
		const navTos = new Set(NAV_ITEMS.map((i) => i.to));
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				expect(navTos.has(sub.route), `${sub.route} 不在导航表,聚光灯无页签可指`).toBe(true);
			}
		}
		// header 的 NavLink 真挂了指路挂点 —— 被重构删掉时这里拦住
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const headerSrc = readFileSync(resolve(__dirname, "../../header.tsx"), "utf8");
		expect(headerSrc).toContain("data-tour-nav={t.to}");
	});

	it("词表里每个锚点都真实挂在某个页面源码上", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		// 扫全站而不是列三个文件名:挂点搬去别的页面/拆进组件时,列表式的守卫会
		// 红在「文件名对不上」而不是「挂点没了」,人就学会改列表而不是信它。
		// 排除导览自己那一箱 —— 词表与脚本本身就写着这些词面,算进来条条都白给。
		const srcDir = resolve(__dirname, "../../..");
		const files = listSources(srcDir, { skipTestDirs: true, skipTestFiles: true }).filter(
			(f) => !f.includes("/components/onboarding/"),
		);
		expect(files.length).toBeGreaterThan(50); // 目录没扫到时别假绿
		const sources = files.map((f) => readFileSync(f, "utf8")).join("\n");
		for (const anchor of TOUR_ANCHORS) {
			// 挂点被重构删掉时这条会红 —— 导览会静默失去高亮,只有这里拦得住。
			// 匹配带引号的词面而非完整 `data-tour="…"`:条件挂点(如 target-test 只挂
			// 在未测通的行上)的词面在三元表达式里。
			expect(sources, `"${anchor}" 挂点不在任何页面上`).toContain(`"${anchor}"`);
		}
	});
});
