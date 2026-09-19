/**
 * 出图回落的账本(ADR-0014 决策 19「回落必须可见」)。
 *
 * 这一层只有两件事值得钉:**去重**(一套坏皮肤每推一张卡就回落一次,不去重的话日志和
 * 面板清单都会被同一句话淹掉)与**封顶**(内存里的东西不能无界长)。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createCardSkinFallbackLog, MAX_CARD_SKIN_FALLBACKS } from "../fallbacks.js";

function makeLog(start = 1_000) {
	let now = start;
	const warn = vi.fn();
	const log = createCardSkinFallbackLog({ logger: { warn }, now: () => now });
	return { log, warn, tick: (ms: number) => (now += ms) };
}

describe("createCardSkinFallbackLog", () => {
	it("同一套皮肤 + 同一种卡 + 同一个原因只占一条,计数与时刻跟着刷新", () => {
		const { log, warn, tick } = makeLog();
		log.record({ skinId: "s1", kind: "live", reason: "皮肤不存在" });
		tick(500);
		log.record({ skinId: "s1", kind: "live", reason: "皮肤不存在" });

		// 验红:把 record() 里命中 prev 时的 early return 去掉(每次都 set 一条新的),
		// 这条红 —— 清单里会有两行一模一样的。
		expect(log.list()).toEqual([
			{ skinId: "s1", kind: "live", reason: "皮肤不存在", at: 1_500, count: 2 },
		]);
		// 日志同样只打第一次:每条推送刷一行的话,日志就成了这套坏皮肤的专栏。
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("换了卡种 / 换了原因就是另一条", () => {
		const { log } = makeLog();
		log.record({ skinId: "s1", kind: "live", reason: "皮肤不存在" });
		log.record({ skinId: "s1", kind: "sc", reason: "皮肤不存在" });
		log.record({ skinId: "s1", kind: "live", reason: "渲染失败(boom)" });
		expect(log.list()).toHaveLength(3);
	});

	it("最近的排在前面", () => {
		const { log, tick } = makeLog();
		log.record({ skinId: "s1", kind: "live", reason: "a" });
		tick(10);
		log.record({ skinId: "s1", kind: "live", reason: "b" });
		expect(log.list().map((r) => r.reason)).toEqual(["b", "a"]);
	});

	/**
	 * 面板上那句「知道了」。账本记的是内存里的一次性痕迹,主人看过之后再留着只会在
	 * 下次打开卡片页时冒充新故障 —— 而真出事的话下一张卡立刻会把它记回来。
	 */
	it("清空之后账本是空的,但新的回落照样记得进来", () => {
		const log = createCardSkinFallbackLog({ now: () => 1 });
		log.record({ skinId: "a", kind: "live", reason: "渲染失败" });
		log.record({ skinId: "b", kind: "sc", reason: "皮肤不存在" });
		expect(log.list()).toHaveLength(2);

		log.clear();
		expect(log.list()).toEqual([]);

		log.record({ skinId: "a", kind: "live", reason: "渲染失败" });
		// 计数从 1 重新起 —— 清空是「这一页翻过去了」,不是「把计数藏起来」。
		expect(log.list()).toEqual([
			{ skinId: "a", kind: "live", reason: "渲染失败", at: 1, count: 1 },
		]);
	});

	it("封顶之后挤掉最旧的那条,不会无界长", () => {
		const { log, tick } = makeLog();
		for (let i = 0; i < MAX_CARD_SKIN_FALLBACKS + 5; i++) {
			log.record({ skinId: `s${i}`, kind: "live", reason: "皮肤不存在" });
			tick(1);
		}
		// 验红:把 record() 里那段「满了先挤掉最旧的」删掉,这两条红。
		expect(log.list()).toHaveLength(MAX_CARD_SKIN_FALLBACKS);
		expect(log.list().map((r) => r.skinId)).not.toContain("s0");
	});
});

/**
 * **淘汰按「最久没再出现」,不是按「最先进来」**(2026-09-19 审查)。
 *
 * `record()` 命中 prev 时是**就地**刷 `at` / `count` 的,而 Map 的插入序不会因此移位 ——
 * 淘汰又是照插入序挑第一个。于是「每条推送都在复发」的那条(`at` 最新、`count` 最高)
 * 会被当成最旧的挤掉,面板上剩 19 条陈年旧账加一个新来的,**真正坏掉的那套皮肤反而
 * 不见了** —— 与这本账存在的理由正好相反。
 *
 * 判据:把 `record()` 里命中 prev 时那两句 `seen.delete(key)` / `seen.set(key, prev)`
 * 拆掉,这一条必须红。
 */
describe("封顶时挤掉谁", () => {
	it("还在复发的那条不许被挤掉 —— 它是最该看的一条", () => {
		const { log, tick } = makeLog();
		// 第一个进来的,也是一直在复发的那个。
		log.record({ skinId: "hot", kind: "live", reason: "皮肤不存在" });
		for (let i = 0; i < MAX_CARD_SKIN_FALLBACKS - 1; i++) {
			tick(1);
			log.record({ skinId: `cold${i}`, kind: "live", reason: "皮肤不存在" });
		}
		// hot 一路在复发:`at` 最新、`count` 最高。
		for (let i = 0; i < 50; i++) {
			tick(1);
			log.record({ skinId: "hot", kind: "live", reason: "皮肤不存在" });
		}
		expect(log.list()[0]).toMatchObject({ skinId: "hot", count: 51 });

		// 再来一条新的 → 必须挤掉最久没再出现的那条(cold0),不是 hot。
		tick(1);
		log.record({ skinId: "新来的", kind: "live", reason: "皮肤不存在" });
		const ids = log.list().map((f) => f.skinId);
		expect(ids).toHaveLength(MAX_CARD_SKIN_FALLBACKS);
		expect(ids).toContain("hot");
		expect(ids).not.toContain("cold0");
	});
});
