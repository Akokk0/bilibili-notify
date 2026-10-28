import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import type { ExtensionContext } from "@bilibili-notify/internal/extension";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDevEntryAttacher } from "../dev-entry.js";
import { createDevtoolsProviderRegistry } from "../providers.js";
import { createDevRegistry } from "../registry.js";

let dir: string;

function started(id: string, controller = new AbortController()) {
	const lines: string[] = [];
	const logger: Logger = {
		info: (message) => lines.push(`info ${message}`),
		warn: (message) => lines.push(`warn ${message}`),
		error: (message) => lines.push(`error ${message}`),
		debug: (message) => lines.push(`debug ${message}`),
	};
	const ctx = { id, signal: controller.signal, logger } as unknown as ExtensionContext;
	return { started: { id, dir, ctx }, lines, controller };
}

async function writeEntry(source: string): Promise<void> {
	await writeFile(join(dir, "devtools.mjs"), source);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-dev-entry-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("createDevEntryAttacher", () => {
	it("认领临时目录里真的 devtools.mjs,现拼 mountUrl,信号中止就撤", async () => {
		await writeEntry(`
export function devtools(ctx) {
	const at = () => ctx.mountUrl() ?? "none";
	return {
		scenarios: [{
			id: "inspect",
			group: "ext",
			title: "Inspect",
			params: [],
			run: () => ({ ok: true, summary: at() }),
			active: () => ({ scenarioId: "inspect", label: at() }),
		}],
	};
}
`);
		const providers = createDevtoolsProviderRegistry();
		const registry = createDevRegistry(providers);
		let address: string | undefined = "127.0.0.1:4567";
		const attach = createDevEntryAttacher({ providers, address: () => address });
		const first = started("demo");

		await attach(first.started);

		await expect(registry.run("demo.inspect", {})).resolves.toMatchObject({
			ok: true,
			summary: "http://127.0.0.1:4567/ext/demo",
			active: [
				{
					scenarioId: "demo.inspect",
					label: "http://127.0.0.1:4567/ext/demo",
				},
			],
		});
		first.controller.abort();
		expect(providers.scenarios()).toEqual([]);
		expect(registry.list()).toEqual([]);

		address = undefined;
		await attach(started("demo").started);
		await expect(registry.run("demo.inspect", {})).resolves.toMatchObject({
			ok: true,
			summary: "none",
		});
	});

	it("没有 devtools.mjs → 不认领,只打一行 info", async () => {
		const providers = createDevtoolsProviderRegistry();
		const attach = createDevEntryAttacher({ providers, address: () => undefined });
		const target = started("demo");

		await attach(target.started);

		expect(providers.scenarios()).toEqual([]);
		expect(target.lines.filter((line) => line.startsWith("info "))).toHaveLength(1);
		expect(target.lines.some((line) => line.startsWith("warn "))).toBe(false);
	});

	it.each(["sub", "target", "connection"])("参数用了 %s → 整包拒并点名场景与参数", async (kind) => {
		await writeEntry(`
export function devtools() {
	return {
		scenarios: [{
			id: "bad",
			group: "ext",
			title: "Bad",
			params: [{ key: "pick", label: "Pick", kind: "${kind}" }],
			run: () => ({ ok: true }),
		}],
	};
}
`);
		const providers = createDevtoolsProviderRegistry();
		const attach = createDevEntryAttacher({ providers, address: () => undefined });
		const target = started("demo");

		await attach(target.started);

		expect(providers.scenarios()).toEqual([]);
		const warning = target.lines.find((line) => line.startsWith("warn "));
		expect(warning).toContain("bad");
		expect(warning).toContain("pick");
		expect(warning).toContain(kind);
	});

	it("参数用了 creator → 挂得上:来源型拓展挑自己名单里的人", async () => {
		await writeEntry(`
export function devtools() {
	return {
		scenarios: [{
			id: "post",
			group: "event",
			title: "Post",
			params: [{ key: "creator", label: "Who", kind: "creator" }],
			run: () => ({ ok: true }),
		}],
	};
}
`);
		const providers = createDevtoolsProviderRegistry();
		const attach = createDevEntryAttacher({ providers, address: () => undefined });
		const target = started("demo");

		await attach(target.started);

		expect(providers.scenarios().map((s) => s.id)).toEqual(["demo.post"]);
		expect(target.lines.some((line) => line.startsWith("warn "))).toBe(false);
	});

	it("文件内容变了 → URL 指纹换掉,再挂拿到新模块", async () => {
		const scenario = (id: string) => `
export function devtools() {
	return {
		scenarios: [{
			id: "${id}",
			group: "ext",
			title: "${id}",
			params: [],
			run: () => ({ ok: true }),
		}],
	};
}
`;
		const providers = createDevtoolsProviderRegistry();
		const registry = createDevRegistry(providers);
		const attach = createDevEntryAttacher({ providers, address: () => undefined });

		await writeEntry(scenario("first"));
		const first = started("demo");
		await attach(first.started);
		expect(registry.list().map((entry) => entry.id)).toEqual(["demo.first"]);
		first.controller.abort();

		await writeEntry(scenario("second"));
		await attach(started("demo").started);
		expect(registry.list().map((entry) => entry.id)).toEqual(["demo.second"]);
	});

	it("devtools() 抛错或交回 thenable → 不认领并 warn", async () => {
		const providers = createDevtoolsProviderRegistry();
		const attach = createDevEntryAttacher({ providers, address: () => undefined });

		await writeEntry(`
export function devtools() {
	throw new Error("入口炸了");
}
`);
		const broken = started("demo");
		await attach(broken.started);
		expect(providers.scenarios()).toEqual([]);
		expect(broken.lines.join("\n")).toContain("入口炸了");

		await writeEntry(`
export function devtools() {
	return Promise.resolve({ scenarios: [] });
}
`);
		const pending = started("demo");
		await attach(pending.started);
		expect(providers.scenarios()).toEqual([]);
		expect(pending.lines.find((line) => line.startsWith("warn "))).toMatch(/同步/);
	});
});
