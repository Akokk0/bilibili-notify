/**
 * 主人目标只许指向私聊目标(ADR-0021 决策 57,3a-18):0.x 的数据迁新代时,`master.targetId` 指向的目标
 * 不满足判据(群、频道、目标不存在)就清空,并在迁移报告里留一笔(首访提示靠它多说一句);指向私聊目标的、
 * 没配主人的原样不动。
 *
 * 设置与目标是两份文件,所以迁移里有单独一步在「连接与目标」「设置」之后两边都读。接缝是
 * 「第 0 代 → `migrateZeroGeneration` → 新代上配置仓开机」。
 */

import { describe, expect, it } from "vite-plus/test";
import { MASTER_TARGET_SKIPPED_PATH } from "../zero-generation.js";
import { useZeroSandbox } from "./support.js";
import { makeZeroGlobals } from "./zero-fixtures.js";

const ID = {
	group: "00000000-0000-4000-8000-000000000001",
	private: "00000000-0000-4000-8000-000000000002",
	ghost: "00000000-0000-4000-8000-0000000000ff",
};

/** 0.x 最老的单文件目标:一个群、一个私聊,同一个 OneBot。 */
const LEGACY_TARGETS = [
	{
		id: ID.group,
		name: "主群",
		platform: "onebot",
		scope: "group",
		enabled: true,
		config: { baseUrl: "http://127.0.0.1:5700", groupId: "111" },
	},
	{
		id: ID.private,
		name: "主人私聊",
		platform: "onebot",
		scope: "private",
		enabled: true,
		config: { baseUrl: "http://127.0.0.1:5700", userId: "222" },
	},
];

describe("迁移:主人目标只许指向私聊目标", () => {
	const sandbox = useZeroSandbox("bn-master-target-");

	async function place(master: { targetId?: string }): Promise<void> {
		await sandbox.placeZero("state/targets.json", LEGACY_TARGETS);
		await sandbox.placeZero("state/globals.json", { ...makeZeroGlobals(), master });
	}

	const diskMaster = () =>
		sandbox
			.readConfig<{ master: { targetId?: string } }>("settings/core.json")
			.then((c) => c.master);

	it("指向群目标 → 清空;报告里记一笔,核心设置记为改写过", async () => {
		await place({ targetId: ID.group });

		const report = await sandbox.migrate();

		expect(await diskMaster()).toEqual({});
		expect(report.skipped.map((s) => s.path)).toContain(MASTER_TARGET_SKIPPED_PATH);
		expect(report.rewritten).toContain("config/settings/core.json");
		expect((await sandbox.load()).getGlobals().master.targetId).toBeUndefined();
	});

	it("指向不存在的目标 → 清空,报告同样记一笔", async () => {
		await place({ targetId: ID.ghost });

		const report = await sandbox.migrate();

		expect(await diskMaster()).toEqual({});
		expect(report.skipped.map((s) => s.path)).toContain(MASTER_TARGET_SKIPPED_PATH);
	});

	it("指向私聊目标 → 不动,报告里没有这一笔", async () => {
		await place({ targetId: ID.private });

		const report = await sandbox.migrate();

		expect(await diskMaster()).toEqual({ targetId: ID.private });
		expect(report.skipped.map((s) => s.path)).not.toContain(MASTER_TARGET_SKIPPED_PATH);
		expect((await sandbox.load()).getGlobals().master.targetId).toBe(ID.private);
	});

	it("没配主人 → 不动,报告里没有这一笔", async () => {
		await place({});

		const report = await sandbox.migrate();

		expect(await diskMaster()).toEqual({});
		expect(report.skipped.map((s) => s.path)).not.toContain(MASTER_TARGET_SKIPPED_PATH);
	});

	it("目标表不在(0.x 没配过目标)而主人目标有值 → 当作指向不存在,清空", async () => {
		await sandbox.placeZero("state/globals.json", {
			...makeZeroGlobals(),
			master: { targetId: ID.private },
		});

		const report = await sandbox.migrate();

		expect(await diskMaster()).toEqual({});
		expect(report.skipped.map((s) => s.path)).toContain(MASTER_TARGET_SKIPPED_PATH);
	});
});
