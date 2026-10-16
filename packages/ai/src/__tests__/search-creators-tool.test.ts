/**
 * `search_creators(source, query)`:转给读口,按来源键找来源的搜人;每行带 `creator`(来源键:外部 id)。
 * 来源键不在册、来源风控这些失败话原样喂回给模型。
 */

import { fail, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AiCandidateView, BiliReader, CreatorReader } from "../tools";
import { executeTool, TOOL_DEFINITIONS } from "../tools";
import { sayOf } from "./harness";

const candidates = (n: number): AiCandidateView[] =>
	Array.from({ length: n }, (_, i) => ({
		creator: `acme:id-${i}`,
		name: `候选${i}`,
		followers: 1000 + i,
		bio: i === 0 ? "长".repeat(100) : undefined,
	}));

function readerWith(searchCreators: CreatorReader["searchCreators"]): CreatorReader {
	return { subscriptions: () => [], externalIdFits: () => true, searchCreators };
}

const run = (args: Record<string, string>, reader: CreatorReader | null) =>
	executeTool("search_creators", args, {} as BiliReader, reader);

describe("search_creators", () => {
	it("source 与 query 原样递给读口;每行带 creator、名字、粉丝,简介截到 80 字", async () => {
		const search = vi.fn(async () => ok({ candidates: candidates(2) }));
		const out = await run({ source: "acme", query: "咩" }, readerWith(search));
		expect(search).toHaveBeenCalledWith("acme", "咩");
		expect(out.ok).toBe(true);
		const [first, second] = sayOf(out).split("\n");
		expect(first).toBe(`1. 候选0（creator: acme:id-0）粉丝: 1000，简介: ${"长".repeat(80)}…`);
		expect(second).toBe("2. 候选1（creator: acme:id-1）粉丝: 1001");
	});

	it("最多给模型 5 个(来源可以回到 10 个)", async () => {
		const out = await run(
			{ source: "acme", query: "x" },
			readerWith(async () => ok({ candidates: candidates(10) })),
		);
		expect(sayOf(out).split("\n")).toHaveLength(5);
	});

	it("没有候选 → 成功,说没找到", async () => {
		const out = await run(
			{ source: "acme", query: "x" },
			readerWith(async () => ok({ candidates: [] })),
		);
		expect(out).toEqual({ ok: true, text: "没有找到相关用户" });
	});

	// 验红:把失败分支改成吞掉(回「没找到」),这条红。
	it("读口回失败(键不在册、风控……)→ 工具失败,码、话、upstreamCode 原样", async () => {
		const out = await run(
			{ source: "nope", query: "x" },
			readerWith(async () => fail("rate_limited", "被风控了", { upstreamCode: -352 })),
		);
		expect(out).toEqual({
			ok: false,
			code: "rate_limited",
			message: "被风控了",
			upstreamCode: -352,
		});
	});

	it("source 或 query 缺 → invalid,不去问读口", async () => {
		const search = vi.fn();
		expect(await run({ query: "x" }, readerWith(search))).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(await run({ source: "acme", query: "  " }, readerWith(search))).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it("没接读口 → unavailable", async () => {
		expect(await run({ source: "acme", query: "x" }, null)).toMatchObject({
			ok: false,
			code: "unavailable",
		});
	});

	it("工具表:有 search_creators(source、query 必填),没有 search_user", () => {
		const names = TOOL_DEFINITIONS.map((t) => t.function.name);
		expect(names).toContain("search_creators");
		expect(names).not.toContain("search_user");
		const def = TOOL_DEFINITIONS.find((t) => t.function.name === "search_creators");
		expect((def?.function.parameters as { required?: string[] } | undefined)?.required).toEqual([
			"source",
			"query",
		]);
	});
});
