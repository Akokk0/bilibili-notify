import type { Context } from "koishi";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildSinglePluginNotice,
	installSinglePluginNotice,
	SINGLE_PLUGIN_LINES,
} from "../single-plugin-merge";

/**
 * v5 把五个插件(core / dynamic / live / ai / advanced-subscription)合并成一个。
 * 这是**要用户动手**的破坏性变更:旧的四个子插件必须卸载,配置得按新的功能域重填。
 *
 * 文案是给所有 koishi 用户看的,把它钉死。尤其是「旧子插件留着也没用」那句 ——
 * 它们靠 `probeInternals()` / `BILIBILI_NOTIFY_TOKEN` 探针协议访问核心,而 v5 把
 * 这套协议整个删了。不写清楚,用户会以为留着无所谓。
 */

/** 最小 h:只记录 tag + children,不碰 koishi 运行时。 */
const fakeH = (tag: string, ...children: unknown[]) => ({ tag, children });

describe("单插件合并 notifier", () => {
	it("是 warning 档 —— 要用户动手,但不是报错", () => {
		expect(buildSinglePluginNotice(fakeH).type).toBe("warning");
	});

	// 五个旧子插件在 npm 上都还在,用户手里很可能装着 —— 漏掉任何一个,那个插件就会被
	// 留在原地(而它已经无法工作)。曾经真的漏过 `-image`,所以这里逐个点名。
	it.each(["-dynamic", "-live", "-ai", "-image", "-advanced-subscription"])(
		"点名要卸载的旧子插件 %s",
		(plugin) => {
			expect(SINGLE_PLUGIN_LINES.join(" ")).toContain(plugin);
		},
	);

	it("明确要求卸载,并说清「留着也没用」", () => {
		const text = SINGLE_PLUGIN_LINES.join(" ");

		expect(text).toMatch(/卸载/);
		// 旧子插件依赖的探针协议已被删除 —— 不讲这一点,用户会以为留着无所谓。
		expect(text).toMatch(/无法工作/);
	});

	it("告知配置结构已重组、需要重新填写", () => {
		const text = SINGLE_PLUGIN_LINES.join(" ");

		expect(text).toMatch(/配置/);
		expect(text).toMatch(/重新填写/);
	});

	it("说清动态/直播/卡片渲染已是核心能力,AI/高级订阅改成了开关", () => {
		const text = SINGLE_PLUGIN_LINES.join(" ");

		expect(text).toMatch(/动态/);
		expect(text).toMatch(/直播/);
		expect(text).toMatch(/卡片渲染/);
		expect(text).toMatch(/开关/);
	});

	// 数字与清单必须自洽:六个插件合并 = 主包 + 五个待卸载子插件。此前标题写「五个」、
	// 清单只列四个(漏了 -image),两处一起错、互相印证,读起来毫无破绽。
	it("标题的「六个」与「五个」和实际清单对得上", () => {
		const text = SINGLE_PLUGIN_LINES.join(" ");
		const subPlugins = ["-dynamic", "-live", "-ai", "-image", "-advanced-subscription"];

		expect(text).toMatch(/六个插件/);
		expect(text).toMatch(/五个旧子插件/);
		expect(subPlugins).toHaveLength(5);
	});

	it("install 把它挂到控制台", () => {
		const create = vi.fn();
		const ctx = { notifier: { create } } as unknown as Context;

		installSinglePluginNotice(ctx, fakeH);

		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
	});
});
