import type { Connection } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import type { SecretCellsReader } from "../../push/connection-settings.js";
import { connectionView } from "../secret-view.js";

/**
 * `connectionView` 的三条分支(适配器不在场 / 设置不合法 / 合法)以及「schema 管不到的从严」。
 * 连接外壳里 `settings` 是 `z.unknown()`:照 `globalConfigView` 的写法(`onUntyped` 原样)搬过来,
 * 整份 settings 会明文下发 —— 这里钉的就是不会。
 */
const connection = (adapterKey: string, settings: unknown): Connection => ({
	id: "00000000-0000-4000-8000-000000000001",
	name: "c",
	enabled: true,
	adapterKey,
	platform: "telegram",
	settings,
	platformSnapshot: snapshotFor("telegram"),
});

const lookupOf = (
	schemas: Record<string, z.ZodType>,
	declared: Record<string, readonly string[]> = {},
): SecretCellsReader => ({
	settingsSchemaOf: (key) => (Object.hasOwn(schemas, key) ? schemas[key] : undefined),
	declaredSecretKeysOf: (key) => (Object.hasOwn(declared, key) ? declared[key] : undefined),
});

describe("connectionView", () => {
	it("适配器不在场 → settings 整格遮挡", () => {
		const view = connectionView(connection("gone", { token: "ABC-SECRET" }), lookupOf({}));
		expect(view.settings).toEqual({ masked: "••••••••" });
		expect(JSON.stringify(view)).not.toContain("ABC-SECRET");
	});

	it("设置不合法 → 整格遮挡 + settingsIssues", () => {
		const lookup = lookupOf({ ext: z.object({ n: z.number() }) });
		const view = connectionView(connection("ext", { n: "不是数字", token: "ABC-SECRET" }), lookup);
		expect(view.settings).toEqual({ masked: "••••••••" });
		expect(view.settingsIssues?.[0]?.path).toEqual(["n"]);
		expect(JSON.stringify(view)).not.toContain("ABC-SECRET");
	});

	describe("拓展适配器在场但声明的密钥键问不出来(declaredSecretKeysOf 回 undefined)", () => {
		const schemas = { ext: z.object({ token: z.string(), note: z.string() }) };
		const settings = { token: "EXT-SECRET", note: "公开" };

		it("合法设置也整格遮挡,密钥原值不出门", () => {
			const view = connectionView(connection("ext", settings), lookupOf(schemas));
			expect(view.settings).toEqual({ masked: "••••••••" });
			expect(JSON.stringify(view)).not.toContain("EXT-SECRET");
		});

		it("声明回 [](问得出来、没声明)→ 照旧逐格,不整格遮挡", () => {
			const view = connectionView(connection("ext", settings), lookupOf(schemas, { ext: [] }));
			expect(view.settings).toEqual({ token: "EXT-SECRET", note: "公开" });
		});

		it("内置适配器(声明恒 undefined)→ 照旧按标记,不整格遮挡", () => {
			const view = connectionView(
				connection("webhook", { note: "公开" }),
				lookupOf({ webhook: z.object({ note: z.string() }) }),
			);
			expect(view.settings).toEqual({ note: "公开" });
		});
	});

	it("schema 管不到的片(z.unknown、record 里没声明的)从严遮挡,不是原样", () => {
		const lookup = lookupOf(
			{ ext: z.object({ blob: z.unknown(), note: z.string() }) },
			{ ext: [] },
		);
		const view = connectionView(
			connection("ext", { blob: { token: "BLOB-SECRET" }, note: "公开" }),
			lookup,
		);
		expect(view.settings).toEqual({ blob: { masked: "••••••••" }, note: "公开" });
		expect(JSON.stringify(view)).not.toContain("BLOB-SECRET");
	});

	it("声明的密钥键任意深度都遮挡,没声明的原样", () => {
		const lookup = lookupOf(
			{ ext: z.object({ links: z.array(z.object({ botKey: z.string(), name: z.string() })) }) },
			{ ext: ["botKey"] },
		);
		const view = connectionView(
			connection("ext", { links: [{ botKey: "DEEP-SECRET", name: "家里" }] }),
			lookup,
		);
		expect(view.settings).toEqual({ links: [{ botKey: { masked: "••••••••" }, name: "家里" }] });
		expect(JSON.stringify(view)).not.toContain("DEEP-SECRET");
	});

	it("外壳各格(含平台快照)原样,不被遮", () => {
		const view = connectionView(connection("gone", { a: 1 }), lookupOf({}));
		expect(view).toMatchObject({
			adapterKey: "gone",
			platform: "telegram",
			platformSnapshot: snapshotFor("telegram"),
		});
	});
});
