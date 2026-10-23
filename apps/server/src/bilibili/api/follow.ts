import { fail, ok, type Result } from "@bilibili-notify/internal";
import { errorMessageOf } from "../../util/error-message.js";
import type { Api } from "./api.js";

/**
 * 关注 UP 主 —— 订阅能否工作的**前提**,不是可有可无的元数据。
 *
 * 动态是从 `feed/all`(**关注流**)拉的,只会返回你已关注的人的动态。所以订阅一个 UP
 * 却不关注他,等于订阅了个寂寞:配置里有记录,动态流里永远没有他,一条都推不出来。
 */

/**
 * 关注一个 UP,把「已关注」「关注自己」也算成功。
 *
 * **绝不抛**:网络炸 / 响应结构不符都返回 `ok:false` + 原因。调用方(新增订阅、启动
 * 时自愈)都不该因为一次关注失败就崩掉或中断整批。
 */
export async function ensureFollowed(api: Api, uid: string): Promise<Result> {
	try {
		const followed = await api.follow(uid);
		return followed.ok ? ok() : followed;
	} catch (e) {
		return fail("unavailable", errorMessageOf(e));
	}
}
