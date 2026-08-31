import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
	auditViteAlias,
	repoRoot,
	resolveViteFrom,
	VITE_PLUS_CORE,
	VITE_PLUS_FRONTENDS,
} from "./vite-alias.mjs";

/**
 * 见 vite-alias.mjs 顶部:这是「每个前端的 vite 都是 Vite+ core」那条不变量的守卫,
 * 接替 apps/desktop 原先靠 typecheck 自己 vite.config.ts 的那道闸。
 *
 * 判定逻辑先用合成数据红绿跑透,再对真实仓库跑一发 —— 只有后者那一条会因为
 * node_modules 的状态而变,前面几条任何机器上都稳定。
 */

const ok = (pkg, version = "0.3.0") => ({ pkg, resolved: { name: VITE_PLUS_CORE, version } });

describe("auditViteAlias", () => {
	it("全都解析到 core 且版本一致 → 没问题", () => {
		expect(auditViteAlias([ok("apps/web"), ok("apps/desktop"), ok("astrbot/page")])).toEqual([]);
	});

	// 这条是这个文件存在的理由:漏一条 override 就是这个样子,而构建和测试都照样绿。
	it("某个前端解析到真 vite → 点名它,并提示是漏了 override", () => {
		const problems = auditViteAlias([
			ok("apps/web"),
			{ pkg: "apps/desktop", resolved: { name: "vite", version: "5.4.21" } },
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("apps/desktop");
		expect(problems[0]).toContain("override");
	});

	it("前端之间 core 版本劈叉 → 报出来(升级时漏改一条 override)", () => {
		const problems = auditViteAlias([ok("apps/web", "0.3.0"), ok("apps/desktop", "0.2.8")]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("0.2.8");
		expect(problems[0]).toContain("0.3.0");
	});

	it("解析不到 → 也是问题,不许当成通过", () => {
		expect(auditViteAlias([{ pkg: "apps/web", resolved: null }])).toEqual([
			"apps/web: 解析不到 vite",
		]);
	});

	it("一次报全,不是遇到第一个就收工", () => {
		const problems = auditViteAlias([
			{ pkg: "apps/web", resolved: { name: "vite", version: "5.4.21" } },
			{ pkg: "apps/desktop", resolved: null },
		]);
		expect(problems).toHaveLength(2);
	});
});

describe("真实仓库", () => {
	it("三个前端的裸 vite 都解析到 Vite+ core,版本一致", () => {
		const root = repoRoot();
		const entries = VITE_PLUS_FRONTENDS.map((pkg) => ({
			pkg,
			resolved: resolveViteFrom(join(root, pkg)),
		}));
		expect(auditViteAlias(entries)).toEqual([]);
	});

	// 另一半:override 之所以带作用域,就是为了别碰 koishi 控制台 UI 的 vite 5。
	// 哪天有人把它们改成 README 那种全局写法,这条会先红。
	it("koishi 侧仍是真 vite 5 —— 作用域没有漏出去", () => {
		const resolved = resolveViteFrom(join(repoRoot(), "koishi"));
		expect(resolved).not.toBeNull();
		expect(resolved.name).toBe("vite");
		expect(resolved.version).toMatch(/^5\./);
	});
});
