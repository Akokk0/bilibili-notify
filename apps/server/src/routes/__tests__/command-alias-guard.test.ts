/**
 * 保存别名时的冲突检查。
 *
 * 撞车的后果是**静默**的:运行时二选一,主人看到某条指令神秘失灵,他会先怀疑机器人
 * 掉线、怀疑权限,唯独想不到是自己起的那个别名。所以拦在保存那一刻。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { checkCommandAliases } from "../command-alias-guard.js";

const COMMANDS = [
	{ name: "status", aliases: ["状态"] },
	{ name: "mute", aliases: ["静音", "免打扰"] },
	{ name: "report", aliases: ["周报"] },
];

function check(patch: Record<string, unknown>, currentAliases: Record<string, string[]> = {}) {
	const current = makeDefaultGlobalConfig();
	current.commands.aliases = currentAliases;
	return checkCommandAliases({ current, patch, commands: COMMANDS });
}

describe("checkCommandAliases", () => {
	// per-scope 门:存别的 tab 不该被一份早就躺在盘上的配置拦住。
	it("这次没碰别名 → 不插手", () => {
		expect(check({ app: { logLevel: "debug" } }).ok).toBe(true);
	});

	it("互不相干的别名照常放行", () => {
		expect(check({ commands: { aliases: { status: ["看看"] } } }).ok).toBe(true);
	});

	it("两条指令抢同一个词 → 拦下,并说清跟谁撞了", () => {
		const r = check({ commands: { aliases: { status: ["安静"], mute: ["安静"] } } });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("安静");
		expect(r.ok === false && r.message).toContain("status");
		expect(r.ok === false && r.message).toContain("mute");
	});

	it("别名撞上别的指令的主名 → 拦下", () => {
		const r = check({ commands: { aliases: { report: ["status"] } } });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("status");
	});

	// 最容易漏的一种:新配的别名撞的是另一条指令**内置**的那个别名。只比对
	// 「这次传上来的这几份」是查不出来的。
	it("别名撞上别的指令的内置别名 → 拦下", () => {
		const r = check({ commands: { aliases: { report: ["静音"] } } });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("静音");
	});

	// dispatcher 的 compile()/匹配都按小写来(`Mute` 和 `mute` 运行时是同一个词),
	// 守卫查重若按原样大小写,只差大小写的坏别名就会落盘 —— 当场只是 reconcile
	// 记条日志,可下一次重启构造期 compile 直接 throw,整个独立端起不来。
	it("与内置主名只差大小写 → 也要拦下(dispatcher 是大小写不敏感的)", () => {
		const r = check({ commands: { aliases: { report: ["Mute"] } } });
		expect(r.ok).toBe(false);
		// 报错用主人写的原样大小写 —— 他要回配置里找的是「Mute」。
		expect(r.ok === false && r.message).toContain("Mute");
	});

	it("同一次 patch 里两条指令的别名只差大小写 → 拦下", () => {
		const r = check({ commands: { aliases: { status: ["Quiet"], mute: ["quiet"] } } });
		expect(r.ok).toBe(false);
	});

	// PATCH 只传了改动的那条,盘上其它几条照旧参与判定。
	it("和盘上已存的别名撞了 → 拦下", () => {
		const r = check({ commands: { aliases: { report: ["安静"] } } }, { mute: ["安静"] });
		expect(r.ok).toBe(false);
	});

	// 整份替换:把 mute 的别名改掉之后,原来那个词就腾出来了。
	it("同一次 patch 里腾出来的词可以被别人用", () => {
		const r = check({ commands: { aliases: { mute: ["安静"], report: ["静音"] } } });
		expect(r.ok).toBe(true);
	});

	it("别名和自己的主名重复 → 也拦下,话说得明白些", () => {
		const r = check({ commands: { aliases: { mute: ["mute"] } } });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("自己");
	});

	it("同一条指令里别名重复 → 拦下", () => {
		const r = check({ commands: { aliases: { mute: ["安静", "安静"] } } });
		expect(r.ok).toBe(false);
	});

	it("清空别名(空数组)是合法的", () => {
		expect(check({ commands: { aliases: { mute: [] } } }).ok).toBe(true);
	});
});

/**
 * 「恢复默认」在线上就是一个显式 `null`(JSON Merge Patch 的删除哨兵,
 * 前端由 buildPatch 自动生成)。判定要按「删掉这个键、回落到内置别名」来算。
 */
describe("恢复默认(显式 null)", () => {
	it("删掉覆盖后回落到内置别名,不当成「没有别名」", () => {
		// 盘上 mute 被改成了「安静」,这次把它恢复默认 → 内置的「静音」重新生效,
		// 于是 report 想叫「静音」就该被拦下。
		const r = check(
			{ commands: { aliases: { mute: null, report: ["静音"] } } },
			{ mute: ["安静"] },
		);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("静音");
	});

	it("恢复默认本身不该被自己拦下", () => {
		const r = check({ commands: { aliases: { mute: null } } }, { mute: ["安静"] });
		expect(r.ok).toBe(true);
	});

	// 整个 aliases 键置 null = 清掉全部覆盖(本仓 merge 语义自定义的合法删除哨兵,
	// deepMerge 删键、schema 回默认 {})。守卫只判 undefined 的话,null 会穿门進
	// Object.entries 抛 TypeError —— 一个合法 PATCH 就这么变成了 500。
	it("整键 aliases:null(清空全部覆盖)是合法形状,不许 500", () => {
		const r = check({ commands: { aliases: null } }, { mute: ["安静"] });
		expect(r.ok).toBe(true);
	});

	// 恢复默认腾出来的词,别人可以接手。
	it("恢复默认腾出的词可以被别人用", () => {
		const r = check(
			{ commands: { aliases: { mute: null, report: ["安静"] } } },
			{ mute: ["安静"] },
		);
		expect(r.ok).toBe(true);
	});
});
