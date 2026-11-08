import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	PersonaCatalogResponse,
	PersonaImportPreviewResponse,
	PersonaWriteResult,
} from "@bilibili-notify/contract";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createApp, createCardSkinStore } from "../../app.js";
import { BUILTIN_INTEGRATION_SETTINGS } from "../../compose.js";
import { i18n } from "../../i18n/index.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";

let dir: string;
let runtime: ReturnType<typeof createAppRuntime>;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-personas-"));
	runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir: dir, logLevel: "silent" },
		{ dataRoot: dir },
		{ integrationSettings: BUILTIN_INTEGRATION_SETTINGS },
	);
	await runtime.configStore.load();
	app = createApp(runtime, { cardSkins: { store: createCardSkinStore(dir) } });
});

it("JSON 只预览，导出内置后导入会生成新身份且不携带选用指针", async () => {
	const before = await catalog();
	const source = required(before.entries[0]);
	const response = await app.request(`/api/ai/personas/${source.id}/export`);
	expect(response.status).toBe(200);
	const file = await response.json();
	expect(file).toMatchObject({
		schemaVersion: 1,
		kind: "maid-persona",
		label: source.label,
		persona: source.persona,
	});
	expect(file).not.toHaveProperty("id");
	expect(file).not.toHaveProperty("activePreset");
	const form = new FormData();
	form.append(
		"file",
		new File([JSON.stringify(file)], "persona.json", { type: "application/json" }),
	);
	const preview = await app.request("/api/ai/personas/import-preview", {
		method: "POST",
		body: form,
	});
	expect(preview.status).toBe(200);
	const parsed = (await preview.json()) as PersonaImportPreviewResponse;
	if (!parsed.ok) throw new Error(parsed.message);
	expect(parsed.content.persona).toEqual(source.persona);
	expect((await catalog()).revision).toBe(before.revision);
	const imported = await write({
		revision: before.revision,
		op: "create",
		content: { ...parsed.content, label: "导入副本" },
	});
	expect(imported.status).toBe(200);
	expect(((await imported.json()) as { id: string }).id).not.toBe(source.id);
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dir, { recursive: true, force: true });
});
const catalog = async () =>
	(await (await app.request("/api/ai/personas")).json()) as PersonaCatalogResponse;
const write = (body: unknown) =>
	app.request("/api/ai/personas", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

it("旧版本和同版本并发写入不能覆盖较新的资源", async () => {
	const before = await catalog();
	const source = required(before.entries[0]);
	const content = { label: "并发副本", persona: source.persona };
	const responses = await Promise.all([
		write({ op: "create", revision: before.revision, content }),
		write({ op: "create", revision: before.revision, content }),
	]);
	expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
	const next = await catalog(),
		copy = required(next.entries.find((entry) => entry.label === content.label));
	expect(next.entries.filter((entry) => entry.label === content.label)).toHaveLength(1);
	expect(
		(
			await write({
				op: "update",
				revision: before.revision,
				id: copy.id,
				content: { ...content, label: "过期写入" },
			})
		).status,
	).toBe(409);
	expect((await catalog()).revision).toBe(next.revision);
	expect(
		(
			await write({
				op: "update",
				revision: next.revision,
				id: copy.id,
				content: { ...content, label: "改名成功" },
			})
		).status,
	).toBe(200);
	expect((await catalog()).entries.find((entry) => entry.id === copy.id)?.label).toBe("改名成功");
});

it("默认和订阅引用受到保护，解除引用后才允许删除；内置只读且可隐藏恢复", async () => {
	const before = await catalog(),
		builtin = required(before.entries[0]),
		other = required(before.entries[1]);
	expect((await write({ op: "remove", id: builtin.id, revision: before.revision })).status).toBe(
		409,
	);
	expect(
		(
			await write({
				op: "update",
				id: other.id,
				revision: before.revision,
				content: { label: "不能改", persona: other.persona },
			})
		).status,
	).toBe(409);
	const created = await write({
		op: "create",
		revision: before.revision,
		content: { label: "引用副本", persona: other.persona },
	});
	const { id } = (await created.json()) as { id: string };
	await runtime.configStore.patchSettings({ core: { ai: { activePreset: id } } });
	expect((await write({ op: "remove", id, revision: (await catalog()).revision })).status).toBe(
		409,
	);
	await runtime.configStore.patchSettings({ core: { ai: { activePreset: builtin.id } } });
	const sub = makeExtensionSubscription();
	sub.overrides.ai = { preset: id };
	await runtime.configStore.upsertSubscription(sub);
	const version = (await catalog()).revision;
	expect((await write({ op: "remove", id, revision: version })).status).toBe(409);
	expect((await catalog()).entries.find((p) => p.id === id)?.usedBy).toContain(`订阅 ${sub.id}`);
	await runtime.configStore.deleteSubscription(sub.id);
	expect((await write({ op: "remove", id, revision: version })).status).toBe(200);
	const fresh = await catalog();
	expect((await write({ op: "remove", id: other.id, revision: fresh.revision })).status).toBe(200);
	const hidden = await catalog();
	expect(hidden.entries.some((p) => p.id === other.id)).toBe(false);
	expect(hidden.removedBuiltins.some((p) => p.id === other.id)).toBe(true);
	expect((await write({ op: "restore", id: other.id, revision: hidden.revision })).status).toBe(
		200,
	);
	expect((await catalog()).entries.find((p) => p.id === other.id)?.persona).toEqual(other.persona);
});

it("未知格式、额外指针及超限文件均拒绝，预览失败不改库", async () => {
	const before = await catalog();
	const valid = {
		schemaVersion: 1,
		kind: "maid-persona",
		label: "测试",
		persona: required(before.entries[0]).persona,
	};
	for (const [body, status] of [
		["not json", 400],
		[JSON.stringify({ ...valid, schemaVersion: 2 }), 400],
		[JSON.stringify({ ...valid, id: "local", activePreset: "local" }), 400],
		[JSON.stringify({ ...valid, persona: { ...valid.persona, unknown: "field" } }), 400],
		[" ".repeat(256 * 1024 + 1), 413],
	] as const) {
		const form = new FormData();
		form.append("file", new File([body], "persona.json"));
		expect(
			(await app.request("/api/ai/personas/import-preview", { method: "POST", body: form })).status,
		).toBe(status);
	}
	expect((await catalog()).revision).toBe(before.revision);
});

it("旧设置页面不能整份写回性格资源，普通选择仍可保存", async () => {
	const before = await catalog();
	for (const ai of [{ presets: [] }, { removedBuiltinPresets: [] }, null]) {
		const response = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ core: { ai } }),
		});
		expect(response.status).toBe(409);
	}
	expect((await catalog()).revision).toBe(before.revision);
	const response = await app.request("/api/settings", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ core: { ai: { activePreset: required(before.entries[1]).id } } }),
	});
	expect(response.status).toBe(200);
});

it("性格资源独立创建并生成本地身份，不切换默认，也不修改其他AI设置", async () => {
	const current = await catalog();
	expect(current.entries.length).toBeGreaterThan(0);
	const before = structuredClone(runtime.configStore.getGlobals().ai);
	const source = current.entries[0];
	if (!source) throw new Error("missing builtin");
	const { label, persona, dynamicPrompt, liveSummaryPrompt } = source;
	const response = await write({
		revision: current.revision,
		op: "create",
		content: { label: `${label} 副本`, persona, dynamicPrompt, liveSummaryPrompt },
	});
	expect(response.status).toBe(200);
	const result = (await response.json()) as PersonaWriteResult;
	if (!result.ok) throw new Error(result.message);
	expect(result.id).not.toBe(source.id);
	const next = await catalog();
	expect(next.entries.find((entry) => entry.id === result.id)?.builtin).toBe(false);
	expect(next.revision).not.toBe(current.revision);
	expect(runtime.configStore.getGlobals().ai.activePreset).toBe(before.activePreset);
	expect(runtime.configStore.getGlobals().ai.providers).toEqual(before.providers);
});

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing fixture entry");
	return value;
}

it.each([
	[
		"en",
		"Global default",
		"This persona could not be found. Reload the library.",
		"Built-in personas are read-only. Make a copy to edit.",
	],
	[
		"ja",
		"全体の既定",
		"この性格が見つかりません。ライブラリーを再読み込みしてください。",
		"内蔵の性格は読み取り専用です。コピーしてから編集してください。",
	],
	["zh-TW", "全域預設", "找不到此性格，請重新載入資源庫。", "內建性格為唯讀，請複製後再編輯。"],
] as const)(
	"localizes persona management in %s without changing identities or revisions",
	async (locale, usage, missing, readonly) => {
		const before = await catalog();
		const builtin = required(before.entries[0]);
		const previous = i18n.state();
		try {
			i18n.set({ locale, voice: "plain" });
			const listed = await catalog();
			expect(listed.revision).toBe(before.revision);
			expect(listed.entries.map((entry) => entry.id)).toEqual(
				before.entries.map((entry) => entry.id),
			);
			expect(listed.entries.find((entry) => entry.id === builtin.id)?.usedBy).toContain(usage);
			const absent = await app.request("/api/ai/personas/missing-persona/export");
			expect(absent.status).toBe(404);
			expect(await absent.json()).toEqual({ code: "not_found", message: missing });
			const rejected = await write({
				op: "update",
				revision: before.revision,
				id: builtin.id,
				content: { label: builtin.label, persona: builtin.persona },
			});
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toEqual({ code: "conflict", message: readonly });
			expect((await catalog()).revision).toBe(before.revision);
		} finally {
			i18n.set(previous);
		}
	},
);
