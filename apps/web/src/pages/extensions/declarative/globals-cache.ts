import type { QueryClient } from "@tanstack/react-query";
import type { GlobalConfig } from "../../../types/globals";

/**
 * 一发 `PATCH /api/globals` 写成之后,把回应当场收进 `["globals"]` 缓存 —— 设置表单与列表那一节
 * **共用这一份**。回应就是合并之后的整份(服务端回的是 `redactGlobals(next)`,与 GET 同形)。
 *
 * 🔴 要在**这一发 mutation 结束之前**收好(调用处在 `onSuccess` 里 await 它):
 * - 列表那一节是整份写回,基线是渲染那一刻的名单。只发一个失效就放手的话,钮一松开缓存还是
 *   写之前那份 —— 这时点第二下,带的名单会把第一下按回去(新建完立刻停用另一条,刚建的就没了)。
 * - 指望不上 WS 那一帧:帧与 HTTP 回应走的是两条连接,谁先到没保证。
 *
 * 收之前先**取消**在飞的重读:它可能是写之前就发出去的(窗口聚焦、上一帧 WS),晚到就把缓存
 * 盖回写之前的样子。取消了也不再重读 —— 回应就是写后的那份,再读一遍是白读。
 *
 * 认下的缝:别的标签页恰好夹在这一发写与它的回应之间写了一笔,它那一帧发起的重读也被取消,
 * 这一页要等下一次失效才看得见。跨标签页的丢更新本来就得服务端带版本号才堵得住,这里不为它
 * 每写一次多读一遍。
 */
export async function adoptWrittenGlobals(qc: QueryClient, written: GlobalConfig): Promise<void> {
	await qc.cancelQueries({ queryKey: ["globals"] });
	qc.setQueryData(["globals"], written);
}
