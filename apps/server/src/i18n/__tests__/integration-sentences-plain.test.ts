import { describe, expect, it } from "vite-plus/test";
import biliPlain from "../../bilibili/locales/zh-CN.json" with { type: "json" };
import biliMaid from "../../bilibili/locales/zh-CN.maid.json" with { type: "json" };
import zhCN from "../locales/zh-CN.json" with { type: "json" };
import zhCNMaid from "../locales/zh-CN.maid.json" with { type: "json" };

/**
 * 集成写进问题表的句子一律平实、只说事:不称呼主人、不自称女仆、不写宿主的界面与操作(ADR-0037 决策 15);
 * 口吻由宿主私聊时加的引子决定。这些句子住在字典里,源码扫描的守卫看不见,所以单独钉一条:
 * 内置集成的两族键(B 站的问题句、QQ 官方的网关句)只许有平实版,值里不许出现下面这些词。
 */
const INTEGRATION_FAMILIES = ["bilibili.problem.", "qqOfficial.gateway."] as const;
const FORBIDDEN = ["主人", "女仆", "面板", "指令", "重启", "login"] as const;

const entries = Object.entries({ ...zhCN, ...biliPlain } as Record<string, string>).filter(
	([key]) => INTEGRATION_FAMILIES.some((family) => key.startsWith(family)),
);

describe("集成写的问题句是平实的", () => {
	it("两族键都在(扫空了比没有还糟)", () => {
		for (const family of INTEGRATION_FAMILIES) {
			expect(
				entries.some(([key]) => key.startsWith(family)),
				family,
			).toBe(true);
		}
	});

	it.each(entries)("%s 不含主人 / 女仆 / 面板 / 指令 / 重启 / login", (key, value) => {
		for (const word of FORBIDDEN) expect(value, `${key} 含「${word}」`).not.toContain(word);
	});

	it("女仆层没有这两族的键(口吻只在宿主加的引子里)", () => {
		const maidKeys = Object.keys({ ...zhCNMaid, ...biliMaid });
		expect(
			maidKeys.filter((key) => INTEGRATION_FAMILIES.some((family) => key.startsWith(family))),
		).toEqual([]);
	});
});
