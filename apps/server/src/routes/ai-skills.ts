/**
 * 女仆技能 API。校验、名字白名单、路径穿越防御全在 `maid-skills/parse.ts` 与
 * `maid-skills/store.ts`,这里只做 wire。
 *
 * 每次 GET 都重新读盘:「真文件、可手放」是这个特性的一半意义(ADR-0001 决策 3),
 * 要是得重启才认得,主人放完刷新一下看不见,只会以为自己放错了地方。代价是一次
 * readdir + 几份小文件,量级可以忽略。
 */

import { coreToolLabelOf } from "@bilibili-notify/ai";
import type { MaidSkillsListResponse } from "@bilibili-notify/contract";
import { fail, issuesFromZod, ok } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import type { AiToolProviderRegistry } from "../ai/tool-provider-registry.js";
import { type MaidSkillReader, skillToolNames } from "../maid-skills/reader.js";
import { type MaidSkillStore, SkillStoreError } from "../maid-skills/store.js";
import { respondFailure } from "./respond-failure.js";

/**
 * 只做形状检查 —— 名字合不合法、长度超没超、正文空不空,全部交给
 * {@link MaidSkillStore} 那一处判(它是拿「写出去再读回来」验的)。两处各判各的,
 * 迟早出现「这儿放行、那儿拒收」。
 */
const writeSchema = z.object({
	name: z.string(),
	description: z.string(),
	allowedTools: z.array(z.string()).optional(),
	disableModelInvocation: z.boolean().optional(),
	body: z.string(),
});

/** 请求体不是一条技能的形状时那一句;逐格原因(zod 的原话)放 `issues`。 */
const NOT_A_SKILL_MESSAGE = "请求体不是一条技能的形状";

export function createAiSkillsRoute(deps: {
	skillStore: MaidSkillStore;
	skillReader: MaidSkillReader;
	aiToolProviders: Pick<AiToolProviderRegistry, "tools">;
}): Hono {
	const { skillStore, skillReader, aiToolProviders } = deps;
	const app = new Hono();

	app.get("/", async (c) => {
		await skillStore.reload();
		// 编辑器摆 `allowed-tools` 勾选框用的那份名单 —— 就是聊天里真挂着的那些,每次现取:
		// 抄一份到别处就等于埋一张早晚过期的表,过期在界面上长成「勾了一把根本不存在的工具」
		// (收窄是交集,那一勾静默无效)。核心取 `TOOL_DEFINITIONS`;`web_search` 不在那张表里
		// (它按主人那颗胶囊现挂),但技能声明得着,所以补上;来源登记的取登记表,停着的来源不在。
		// 漏配标签的工具在 `toolLabels` 里就没有这一格,有测试盯着。
		const provided = aiToolProviders.tools();
		const names = skillToolNames(aiToolProviders);
		const toolLabels: Record<string, string> = {};
		for (const name of names) {
			const label = coreToolLabelOf(name)?.label;
			if (label !== undefined) toolLabels[name] = label;
		}
		for (const tool of provided) {
			toolLabels[tool.definition.function.name] = tool.label;
		}
		const body: MaidSkillsListResponse = {
			list: skillReader.list(),
			problems: skillReader.problems(),
			tools: names,
			toolLabels,
		};
		return c.json(body);
	});

	app.post("/", async (c) => {
		const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", NOT_A_SKILL_MESSAGE, { issues: issuesFromZod(parsed.error) }),
			);
		}
		// 与 PUT / DELETE 同待遇。名字占用那道闸自己会问盘(见 store.assertFree),
		// 所以这句不是防线 —— 它只是别让 create 把一份残缺索引当成全库。
		await skillStore.ensureReady();
		try {
			await skillStore.create({ disableModelInvocation: false, ...parsed.data });
		} catch (err) {
			// 只接技能库自己拒收的(名字不合法 400、重名 409);别的抛错是环境或 bug 的事,往上抛。
			if (err instanceof SkillStoreError) return respondFailure(c, err.toFailure());
			throw err;
		}
		return c.json(ok());
	});

	app.put("/:name", async (c) => {
		const name = c.req.param("name");
		const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", NOT_A_SKILL_MESSAGE, { issues: issuesFromZod(parsed.error) }),
			);
		}
		await skillStore.ensureReady();
		try {
			await skillStore.update(name, { disableModelInvocation: false, ...parsed.data });
		} catch (err) {
			if (err instanceof SkillStoreError) return respondFailure(c, err.toFailure());
			throw err;
		}
		return c.json(ok());
	});

	app.delete("/:name", async (c) => {
		const name = c.req.param("name");
		await skillStore.ensureReady();
		try {
			await skillStore.remove(name);
		} catch (err) {
			// 名字不合法(`invalid`)与「没这条」(`not_found`)都从这儿出来。都不是 500 —— 前者是主人
			// (或攻击者)给了个走不通的名字,后者是他手快点了两次删除。
			if (err instanceof SkillStoreError) return respondFailure(c, err.toFailure());
			throw err;
		}
		return c.json(ok());
	});

	return app;
}
