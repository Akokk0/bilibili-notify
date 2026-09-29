import { fail, ok, type Result } from "@bilibili-notify/internal";
import type { Context } from "hono";
import { z } from "zod";

/**
 * 读 JSON 请求体的两个口子 —— 配置写入的那几条路由(订阅 / 推送目标 / 连接 / 全局设置)共用。
 * 读不成回的是 `Failure`,路由直接 `respondFailure(c, read)`,不必各写一份「体不是 JSON」的话:
 * 十来处各写各的,英文机器串和状态码迟早又长回来。
 */

/** 请求体要是合法的 JSON;不是回 `invalid`。 */
export async function readJsonBody(c: Context): Promise<Result<{ body: unknown }>> {
	try {
		return ok({ body: await c.req.json() });
	} catch {
		return fail("invalid", "请求体不是合法的 JSON");
	}
}

const ObjectBodySchema = z.record(z.string(), z.unknown());

/** PATCH 体:合法的 JSON,且是个对象(数组、单个值不算)。 */
export async function readJsonObject(
	c: Context,
): Promise<Result<{ body: Record<string, unknown> }>> {
	const read = await readJsonBody(c);
	if (!read.ok) return read;
	const shape = ObjectBodySchema.safeParse(read.body);
	if (!shape.success) return fail("invalid", "请求体要是一个 JSON 对象，不能是数组或单个值");
	return ok({ body: shape.data });
}
