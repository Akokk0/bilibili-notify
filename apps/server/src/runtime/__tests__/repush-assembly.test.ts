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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { createAppRuntime } from "../bootstrap.js";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-repush-asm-"));
});
afterEach(async () => {
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
});
