import type {
	ExtensionSettingsIssue,
	ExtensionSettingsResponse,
	ExtensionSettingsWriteResponse,
} from "@bilibili-notify/contract";
import {
	ExtensionIdSchema,
	type ExtensionManifestField,
	fail,
	formatZodIssues,
	issuesFromZod,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { type ZodType, z } from "zod";
import type { ConfigStore } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import {
	applySettingsOps,
	commitSettings,
	maskSettings,
	newExtensionIssues,
	settingsRevision,
} from "../extensions/settings-io.js";
import { respondFailure } from "./respond-failure.js";

export interface ExtensionSettingsRouteOptions {
	store: Pick<ConfigStore, "getGlobals" | "updateGlobals">;
	/** 装着的那些 —— 清单(设置项声明)从这儿读,**没在跑的也有**(「装好 → 填 → 启用」)。 */
	extensions: () => readonly ExtensionEntry[];
	/**
	 * 某个拓展经 `ctx.settings(schema)` 交过的 zod(ADR-0019 决策 35)。没在跑是 `undefined`,跑着但
	 * 没交过是空表 —— 两种都只有清单那一道。不给这一格同理。「设置读不了」的(决策 36)不跑也有:
	 * 装载器交它收摊前留下的那份,改对一条放行、写坏别的照样拦下。
	 */
	settingsSchemas?: (id: string) => readonly ZodType[] | undefined;
	/** 某个拓展的设置经这里写进去了 —— 宿主把它转成一帧推给面板。 */
	settingsChanged?: (id: string) => void;
}

const OpSchema = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("set"), key: z.string().min(1), value: z.unknown() }),
	z.strictObject({
		op: z.literal("add"),
		list: z.string().min(1),
		item: z.record(z.string(), z.unknown()),
	}),
	z.strictObject({
		op: z.literal("update"),
		list: z.string().min(1),
		id: z.string().min(1),
		values: z.record(z.string(), z.unknown()),
	}),
	z.strictObject({ op: z.literal("remove"), list: z.string().min(1), id: z.string().min(1) }),
]);

const PatchSchema = z
	.strictObject({ revision: z.string().min(1), ops: z.array(OpSchema).min(1) })
	.superRefine((body, ctx) => {
		// `value` 缺了与 `null` 是两回事:一个是「忘了带」,一个是「清掉」。缺了的按清掉办,
		// 一格就在主人不知情时没了。
		body.ops.forEach((op, i) => {
			if (op.op === "set" && !("value" in op)) {
				ctx.addIssue({
					code: "custom",
					path: ["ops", i, "value"],
					message: "set 要带 value(清掉那一格用 null)",
				});
			}
		});
	});

/** 这个 id 有没有一份能照着管的设置声明:有就交出 id 与设置项,没有是 `invalid`(id 不合规矩)或 `not_found`。 */
type Resolved = Result<{ id: string; fields: readonly ExtensionManifestField[] }>;

/**
 * 拓展设置自己的读写口(ADR-0019 决策 35)—— 挂在 `/api/ext` 底下,吃面板会话鉴权。
 *
 * 存储仍在 globals 的 `extensions.<id>.settings`,逻辑在 `extensions/settings-io.ts`,这里只做 wire。
 * 不走 `PATCH /api/globals` 的理由:列表只能整份写回(两发交错就丢一发),`id` 不可变与密钥占位
 * 回填都表达不了;给 globals 补版本号又会让互不相干的全局写入互相 409。
 */
export function createExtensionSettingsRoute(opts: ExtensionSettingsRouteOptions): Hono {
	const app = new Hono();

	/** 这个 id 有没有一份能照着管的设置声明 —— 没有的每一种都说清为什么。 */
	function resolve(raw: string): Resolved {
		const parsed = ExtensionIdSchema.safeParse(raw);
		if (!parsed.success) return fail("invalid", "拓展 id 不合规矩");
		const id = parsed.data;
		const entry = opts.extensions().find((candidate) => candidate.id === id);
		if (!entry) return fail("not_found", `没有装名叫 ${id} 的拓展`);
		const { manifest } = entry;
		if (!manifest) {
			return fail("not_found", `拓展 ${id} 的清单读不出来(或版本不合),没有能照着管的设置项`);
		}
		if (manifest.apiVersion === 1) {
			return fail(
				"not_found",
				`拓展 ${id} 是老格式(v1)清单,设置不在清单里、不走这里 —— 去市场更新之后才能在这里管理`,
			);
		}
		const fields = manifest.settings?.fields ?? [];
		if (fields.length === 0) return fail("not_found", `拓展 ${id} 的清单里没声明设置项`);
		return ok({ id, fields });
	}

	/**
	 * 版本号对不上:只说这句话,不带现在的版本号 —— 面板据 `code` 重读一遍(GET 里有现在的)再改,
	 * 而不是把别人刚写的盖掉。
	 */
	const conflict = () =>
		fail("conflict", "设置在你打开之后被改过了 —— 重新读一遍再改,别把刚写进去的盖掉");

	/**
	 * 校验不过:`message` 一句概括,逐条原因放 `issues`(每条 `{ path, message, op? }`)—— 面板按
	 * `path` 逐格标红,`op` 认得出是这次写的第几步惹的。一条也要放:没有 `path` 面板落不到那一格。
	 */
	const invalid = (issues: ExtensionSettingsIssue[]) =>
		fail("invalid", `拓展设置没通过检查（共 ${issues.length} 条）`, { issues });

	/** 下发的那一份:密钥遮着,带版本号。GET 与 PATCH 的回应共用这一段,两边不许说成两种样子。 */
	function view(fields: readonly ExtensionManifestField[], stored: unknown) {
		return { revision: settingsRevision(stored), values: maskSettings(fields, stored) };
	}

	app.get("/:id/settings", (c) => {
		const target = resolve(c.req.param("id"));
		if (!target.ok) return respondFailure(c, target);
		const body: ExtensionSettingsResponse = view(
			target.fields,
			opts.store.getGlobals().extensions[target.id]?.settings,
		);
		return c.json(body);
	});

	app.patch("/:id/settings", async (c) => {
		const target = resolve(c.req.param("id"));
		if (!target.ok) return respondFailure(c, target);
		const { id, fields } = target;
		const parsed = PatchSchema.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) {
			// 请求体本身不成形(面板不会发这样的)。zod 自己的字段不往外甩:只留路径与原话。
			return respondFailure(
				c,
				fail("invalid", `请求体不合规矩：${formatZodIssues(parsed.error).join(";")}`, {
					issues: issuesFromZod(parsed.error),
				}),
			);
		}
		const { revision, ops } = parsed.data;

		// 队外先比一次:拿着旧版本号来的,不必往下算。**这一道不算数** —— 算数的那道在
		// `commitSettings` 里、在排队里。
		const stored = opts.store.getGlobals().extensions[id]?.settings;
		const current = settingsRevision(stored);
		if (revision !== current) return respondFailure(c, conflict());

		const applied = applySettingsOps(fields, stored, ops);
		if (!applied.ok) return respondFailure(c, invalid(applied.issues));

		// 拓展在跑时再过它自己那份 zod(决策 35 第三点)。在队外跑:它是异步的、是拓展的代码,
		// 挂住的话不能连累之后所有的全局设置写入。
		const schemas = opts.settingsSchemas?.(id) ?? [];
		if (schemas.length > 0) {
			let fresh: Awaited<ReturnType<typeof newExtensionIssues>>;
			try {
				fresh = await newExtensionIssues(schemas, fields, stored, applied.next);
			} catch (err) {
				// 拓展自己的校验代码抛了:不是「不合规矩」,是它出错 —— 对端的错,原话给主人(与动作
				// 抛了同一档:`unavailable`)。
				const reason = err instanceof Error ? err.message : String(err);
				return respondFailure(
					c,
					fail(
						"unavailable",
						`拓展 ${id} 自己的设置校验抛了(不是「不合规矩」,是它的代码出错):${reason}`,
					),
				);
			}
			if (fresh.length > 0) {
				return respondFailure(
					c,
					invalid(
						fresh.map(({ path, message }): ExtensionSettingsIssue => {
							const op = applied.opOf(path);
							return op === undefined ? { path, message } : { op, path, message };
						}),
					),
				);
			}
		}

		const committed = await commitSettings(opts.store, id, revision, applied.next);
		if (!committed.ok) return respondFailure(c, conflict());
		opts.settingsChanged?.(id);
		const body: ExtensionSettingsWriteResponse = {
			...view(fields, committed.settings),
			added: applied.added,
		};
		return c.json(body);
	});

	return app;
}
