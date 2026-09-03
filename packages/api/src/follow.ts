import type { BilibiliAPI } from "./bilibili-api.js";

/**
 * 关注 UP 主 —— 订阅能否工作的**前提**,不是可有可无的元数据。
 *
 * 动态是从 `feed/all`(**关注流**)拉的,只会返回你已关注的人的动态。所以订阅一个 UP
 * 却不关注他,等于订阅了个寂寞:配置里有记录,动态流里永远没有他,一条都推不出来。
 */

/**
 * 「关注这件事已经成立」的业务码。
 *
 * - `0`     —— 关注成功
 * - `22014` —— 已经关注过了(重复关注)。**这不是失败** —— 目标状态已达成。
 * - `22001` —— 不能关注自己。也当成功:主人订阅自己是合法用例,动态照样收得到
 *              (自己的动态本来就在自己的 feed 流里)。
 *
 * 这套判定是当年 koishi 插件的 subscription-loader 跑了很久验证过的,提到共享包里,
 * 免得两端各写一份、各错一份。
 */
export const FOLLOW_SUCCESS_CODES: ReadonlySet<number> = new Set([0, 22014, 22001]);

export interface FollowOutcome {
	ok: boolean;
	code: number;
	message: string;
}

/**
 * 关注一个 UP,把「已关注」「关注自己」也算成功。
 *
 * **绝不抛**:网络炸 / 响应结构不符都返回 `ok:false` + 原因。调用方(新增订阅、启动
 * 时自愈)都不该因为一次关注失败就崩掉或中断整批。
 */
export async function ensureFollowed(api: BilibiliAPI, uid: string): Promise<FollowOutcome> {
	try {
		const res = (await api.follow(uid)) as { code?: unknown; message?: unknown } | null;
		const code = typeof res?.code === "number" ? res.code : -1;
		const message = typeof res?.message === "string" ? res.message : "";
		return { ok: FOLLOW_SUCCESS_CODES.has(code), code, message };
	} catch (e) {
		return { ok: false, code: -1, message: e instanceof Error ? e.message : String(e) };
	}
}
