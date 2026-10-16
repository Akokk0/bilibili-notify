/**
 * **真装配里,连接没了,关于它的问题跟着清**(接线守卫)。
 *
 * 问题表的 `clearConnection` 有自己的单测,可证明不了 `bootstrap.ts` 里订了 `config-changed { connections }`:
 * 漏掉的症状是连接删了,问题框里还挂着一条关于它的问题,门禁全绿。所以这里走真的 `createAppRuntime`:
 * 配置仓删连接(路由删除走的就是它)与整表被换(恢复备份走的路,同样发 `config-changed { connections }`)
 * 之后,问题表里关于已不在的连接的问题都没了,别的不动。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-connection-problems-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
	await runtime.configStore.load();
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

function webhookDraft(): Omit<Connection, "platformSnapshot"> {
	return {
		id: randomUUID(),
		name: "钉钉",
		platform: "dingtalk",
		enabled: true,
		adapterKey: "webhook",
		settings: { url: "https://example.com/hook" },
	};
}

describe("createAppRuntime 里的连接问题", () => {
	it("删掉一条连接:关于它的问题跟着没了,关于别的连接与订阅的不动", async () => {
		const a = webhookDraft();
		const b = webhookDraft();
		await runtime.configStore.createConnection(a, snapshotFor("dingtalk"));
		await runtime.configStore.createConnection(b, snapshotFor("dingtalk"));
		runtime.problems.report({
			reporter: "webhook",
			about: { connectionId: a.id },
			code: "gateway_down",
			message: "a 连不上",
		});
		runtime.problems.report({
			reporter: "webhook",
			about: { connectionId: b.id },
			code: "gateway_down",
			message: "b 连不上",
		});
		runtime.problems.report({
			reporter: "webhook",
			about: { subscriptionId: a.id },
			code: "gateway_down",
			message: "同一个 id 的订阅",
		});

		expect(runtime.problems.list()).toHaveLength(3);

		expect(await runtime.configStore.deleteConnection(a.id)).toBe(true);

		expect(runtime.problems.list().map((p) => p.message)).toEqual(["b 连不上", "同一个 id 的订阅"]);
	});

	it("连接表被整表换掉(恢复备份):换完发 connections 变了,已不在的连接的问题清掉", async () => {
		const gone = randomUUID();
		runtime.problems.report({
			reporter: "webhook",
			about: { connectionId: gone },
			code: "gateway_down",
			message: "一条早已不在的连接",
		});
		runtime.problems.report({
			reporter: "webhook",
			code: "adapter_broken",
			message: "适配器自己的",
		});

		runtime.bus.emit("config-changed", { scope: "connections" });

		expect(runtime.problems.list().map((p) => p.message)).toEqual(["适配器自己的"]);
	});

	it("别的 scope 变了不扫", async () => {
		runtime.problems.report({
			reporter: "webhook",
			about: { connectionId: randomUUID() },
			code: "gateway_down",
			message: "m",
		});
		runtime.bus.emit("config-changed", { scope: "targets" });
		expect(runtime.problems.list()).toHaveLength(1);
	});
});
