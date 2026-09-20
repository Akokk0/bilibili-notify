/**
 * **真装配里,历史仓身上确实挂着重推原件**(ADR-0017)。
 *
 * `repush-store.test.ts` 证明原件自己存得对,`repush-wiring.test.ts` 证明历史仓**被给了
 * 原件时**会去调它 —— 两条都是在自己搭的零件上跑的,谁都证明不了**生产装配**里那一行
 * `repush: repushStore` 真的写上了。漏了它的症状是:一切正常,推送照记、面板照显示,
 * 只有重推按钮永远是灰的,而进程一个字都不说。
 *
 * 所以这一条走真的 `createAppRuntime`,record 一行,然后去盘上看那份原件在不在。
 *
 * (保留期那一跳**没有对应的线**:`startHistoryRetention` 缺省自己建一个 RepushStore ——
 * 它没有内部状态,`dataDir` 那儿本来就有。没有线就没有可漏的地方。)
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { createAppRuntime } from "../bootstrap.js";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-repush-asm-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dataDir, { recursive: true, force: true });
});

describe("createAppRuntime", () => {
	it("落一行历史 → 盘上同时多出一份重推原件", async () => {
		const runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }));
		const entry = await runtime.historyStore.record({
			pushId: randomUUID(),
			kind: "dynamic",
			uid: "u1",
			subscriptionId: randomUUID(),
			target: randomUUID(),
			messages: [
				{
					payload: { kind: "text", text: "卡片" },
					role: "main",
					result: { ok: false, latencyMs: 1, err: "boom" },
				},
			],
		});
		expect(entry.status).toBe("failed");
		const drafts = await readdir(join(dataDir, "history", "repush", entry.ts.slice(0, 10)));
		expect(drafts).toContain(`${entry.id}.json`);
	});

	/**
	 * **重推的 runner 接的是真东西。**
	 *
	 * 这一条走完:`findRow` 在真历史仓里找到了那一行,闸从真 ConfigStore 里读路由 ——
	 * 而这个 dataDir 里一条订阅都没有,所以它据实拒绝,理由正是「路由里没有这个目标」。
	 * 换掉任何一头(桩住的 store、写死的 routedTargets)这条都会变。
	 *
	 * ⚠️ **没钉到的那一跳**:`send` 里 `engines.push.sendToTarget` 那一句 —— 这里没有
	 * 推送引擎(它是后挂的),造一套出来的代价远大于这条守卫的价值。runner 自己那份
	 * 测试把发送语义全覆盖了,这里只证明它被装进了 runtime、接的是真配置。
	 */
	it("repushRunner 接的是真历史仓与真配置", async () => {
		const runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }));
		const entry = await runtime.historyStore.record({
			pushId: randomUUID(),
			kind: "dynamic",
			uid: "u1",
			subscriptionId: randomUUID(),
			target: randomUUID(),
			messages: [
				{
					payload: { kind: "text", text: "卡片" },
					role: "main",
					result: { ok: false, latencyMs: 1, err: "boom" },
				},
			],
		});
		const res = await runtime.repushRunner.start(entry.id, entry.ts, "missing");
		// 行找到了(不是 notFound),但这个 dataDir 里没有任何订阅 —— 闸据实拒绝。
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("本该拒");
		expect(res.notFound).toBeUndefined();
		expect(res.reason).toContain("路由");
	});

	/**
	 * **闸读的是快照,不是每行现问一遍 ConfigStore。**
	 *
	 * 列表端点为**每一条** failed / partial 行各调一次 `canRepush`,而 ConfigStore 的
	 * `getSubscriptions` / `getTargets` / `getConnections` 全是整份 `deepClone`
	 * (structuredClone)。重推要解的场景(bot 离线一段时间)恰恰是一整页全红 —— 面板
	 * 一次拿 200 行,现问就是 600 份订阅 / 目标 / 连接副本,订阅里还装着 per-UP 的
	 * templates / cardStyle / extras。闸越往后加条件,每行付的钱越多。
	 *
	 * 把 `target-scope` 那张表换回「每次现问」这条就红(200 → 600 次)。
	 */
	it("200 行失败历史各问一次闸 → 三个 deepClone getter 各只被问一次", async () => {
		const runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }));
		const entry = await runtime.historyStore.record({
			pushId: randomUUID(),
			kind: "dynamic",
			uid: "u1",
			subscriptionId: randomUUID(),
			target: randomUUID(),
			messages: [
				{
					payload: { kind: "text", text: "卡片" },
					role: "main",
					result: { ok: false, latencyMs: 1, err: "boom" },
				},
			],
		});
		// 快照是惰性的(createAppRuntime 跑在 configStore.load() 之前),所以装桩赶得及。
		const subs = vi.spyOn(runtime.configStore, "getSubscriptions");
		const targets = vi.spyOn(runtime.configStore, "getTargets");
		const connections = vi.spyOn(runtime.configStore, "getConnections");
		for (let i = 0; i < 200; i++) {
			await runtime.repushRunner.canRepush({ ...entry, id: randomUUID() });
		}
		expect(subs).toHaveBeenCalledTimes(1);
		expect(targets).toHaveBeenCalledTimes(1);
		expect(connections).toHaveBeenCalledTimes(1);
	});
});
