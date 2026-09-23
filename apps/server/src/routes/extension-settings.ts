import type {
	ExtensionSettingsConflict,
	ExtensionSettingsIssue,
	ExtensionSettingsResponse,
	ExtensionSettingsWriteResponse,
} from "@bilibili-notify/contract";
import {
	ExtensionIdSchema,
	type ExtensionManifestField,
	formatZodIssues,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
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

type Resolved =
	| { ok: true; id: string; fields: readonly ExtensionManifestField[] }
	| { ok: false; status: 400 | 404; message: string };

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
		if (!parsed.success) return { ok: false, status: 400, message: "拓展 id 不合规矩" };
		const id = parsed.data;
		const entry = opts.extensions().find((candidate) => candidate.id === id);
		if (!entry) return { ok: false, status: 404, message: `没有装名叫 ${id} 的拓展` };
		const { manifest } = entry;
		if (!manifest) {
			return {
				ok: false,
				status: 404,
				message: `拓展 ${id} 的清单读不出来(或版本不合),没有能照着管的设置项`,
			};
		}
		if (manifest.apiVersion === 1) {
			return {
				ok: false,
				status: 404,
				message: `拓展 ${id} 是老格式(v1)清单,设置不在清单里、不走这里 —— 去市场更新之后才能在这里管理`,
			};
		}
		const fields = manifest.settings?.fields ?? [];
		if (fields.length === 0) {
			return { ok: false, status: 404, message: `拓展 ${id} 的清单里没声明设置项` };
		}
		return { ok: true, id, fields };
	}

	function refuse(c: Context, target: Extract<Resolved, { ok: false }>) {
		const error = target.status === 404 ? "not_found" : "invalid_id";
		return c.json({ error, message: target.message }, target.status);
	}

	function conflict(c: Context, revision: string) {
		const body: ExtensionSettingsConflict = {
			error: "revision_conflict",
			message: "设置在你打开之后被改过了 —— 重新读一遍再改,别把刚写进去的盖掉",
			revision,
		};
		return c.json(body, 409);
	}

	function invalid(c: Context, issues: ExtensionSettingsIssue[]) {
		// `message` 是给只认一句话的调用方的(ApiError 取它);面板按 `issues` 逐格画。
		const message = issues
			.map((issue) => `${issue.path.join(".") || "(根)"}:${issue.message}`)
			.join(";");
		return c.json({ error: "validation_failed", message, issues }, 400);
	}

	/** 下发的那一份:密钥遮着,带版本号。GET 与 PATCH 的回应共用这一段,两边不许说成两种样子。 */
	function view(fields: readonly ExtensionManifestField[], stored: unknown) {
		return { revision: settingsRevision(stored), values: maskSettings(fields, stored) };
	}

	app.get("/:id/settings", (c) => {
		const target = resolve(c.req.param("id"));
		if (!target.ok) return refuse(c, target);
		const body: ExtensionSettingsResponse = view(
			target.fields,
			opts.store.getGlobals().extensions[target.id]?.settings,
		);
		return c.json(body);
	});

	app.patch("/:id/settings", async (c) => {
		const target = resolve(c.req.param("id"));
		if (!target.ok) return refuse(c, target);
		const { id, fields } = target;
		const parsed = PatchSchema.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) {
			return c.json(
				{
					error: "invalid_payload",
					message: formatZodIssues(parsed.error).join(";"),
					issues: parsed.error.issues,
				},
				400,
			);
		}
		const { revision, ops } = parsed.data;

		// 队外先比一次:拿着旧版本号来的,不必往下算。**这一道不算数** —— 算数的那道在
		// `commitSettings` 里、在排队里。
		const stored = opts.store.getGlobals().extensions[id]?.settings;
		const current = settingsRevision(stored);
		if (revision !== current) return conflict(c, current);

		const applied = applySettingsOps(fields, stored, ops);
		if (!applied.ok) return invalid(c, applied.issues);

		// 拓展在跑时再过它自己那份 zod(决策 35 第三点)。在队外跑:它是异步的、是拓展的代码,
		// 挂住的话不能连累之后所有的全局设置写入。
		const schemas = opts.settingsSchemas?.(id) ?? [];
		if (schemas.length > 0) {
			let fresh: Awaited<ReturnType<typeof newExtensionIssues>>;
			try {
				fresh = await newExtensionIssues(schemas, fields, stored, applied.next);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return c.json(
					{
						error: "extension_check_failed",
						message: `拓展 ${id} 自己的设置校验抛了(不是「不合规矩」,是它的代码出错):${reason}`,
					},
					500,
				);
			}
			if (fresh.length > 0) {
				return invalid(
					c,
					fresh.map(({ path, message }) => {
						const op = applied.opOf(path);
						return op === undefined ? { path, message } : { op, path, message };
					}),
				);
			}
		}

		const committed = await commitSettings(opts.store, id, revision, applied.next);
		if (!committed.ok) return conflict(c, committed.revision);
		opts.settingsChanged?.(id);
		const body: ExtensionSettingsWriteResponse = {
			...view(fields, committed.settings),
			added: applied.added,
		};
		return c.json(body);
	});

	return app;
}
