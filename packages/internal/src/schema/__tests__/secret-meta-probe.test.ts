import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

/**
 * 探针:钉住 zod 4 的 `.meta()` 在各种包裹下的真实行为 —— 标记遍历器(`secret.ts`)的设计就押在这几条上。
 * zod 升级后哪条变了,这里先红。
 */
const meta = (s: unknown) => z.globalRegistry.get(s as z.ZodType);

describe("zod meta 探针", () => {
	it("meta 挂在返回的新实例上,原实例不带", () => {
		const base = z.string();
		const tagged = base.meta({ secret: true });
		expect(meta(tagged)).toMatchObject({ secret: true });
		expect(meta(base)).toBeUndefined();
	});

	it("meta 之后再 .optional() / .default():外层实例不带 meta,里层带", () => {
		const opt = z.string().meta({ secret: true }).optional();
		expect(meta(opt)).toBeUndefined();
		const inner = (opt as unknown as { _zod: { def: { innerType: unknown } } })._zod.def.innerType;
		expect(meta(inner)).toMatchObject({ secret: true });
		const def = z.string().meta({ secret: true }).default("");
		expect(meta(def)).toBeUndefined();
		const inner2 = (def as unknown as { _zod: { def: { innerType: unknown } } })._zod.def.innerType;
		expect(meta(inner2)).toMatchObject({ secret: true });
	});

	it("先 .optional() 再 .meta():外层带 meta", () => {
		expect(meta(z.string().optional().meta({ secret: true }))).toMatchObject({ secret: true });
	});

	it("联合与 record:meta 留在各自的值类型上", () => {
		const u = z.union([z.string().meta({ secret: true }), z.number()]);
		const opts = (u as unknown as { _zod: { def: { options: unknown[] } } })._zod.def.options;
		expect(meta(opts[0])).toMatchObject({ secret: true });
		expect(meta(opts[1])).toBeUndefined();
		const r = z.record(z.string(), z.string().meta({ secret: true }));
		const vt = (r as unknown as { _zod: { def: { valueType: unknown } } })._zod.def.valueType;
		expect(meta(vt)).toMatchObject({ secret: true });
	});

	it("pipe / preprocess:meta 打在输出侧的里层,遍历要走 in 与 out", () => {
		const p = z.preprocess((v) => v, z.string().meta({ secret: true }));
		const def = (p as unknown as { _zod: { def: { type: string; in: unknown; out: unknown } } })
			._zod.def;
		expect(def.type).toBe("pipe");
		expect(meta(def.out)).toMatchObject({ secret: true });
	});

	it("meta 不改推导类型,也不影响 .strict()", () => {
		const o = z.object({ a: z.string().meta({ secret: true }) }).strict();
		expect(o.safeParse({ a: "x" }).success).toBe(true);
		expect(o.safeParse({ a: "x", b: 1 }).success).toBe(false);
	});
});
