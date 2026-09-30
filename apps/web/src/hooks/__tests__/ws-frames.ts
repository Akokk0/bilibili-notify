import type { WsEventEnvelope } from "@bilibili-notify/contract";

/** 事件帧去掉必填的 `ts`(逐个成员去,判别键 `type` / `event` 与 `data` 的对应关系才不会塌掉)。 */
type WithoutTs<F> = F extends unknown ? Omit<F, "ts"> & { ts?: string } : never;

/**
 * 造「服务端发来的一帧合法事件帧」的函数。形状严格照 contract 的事件表(`WsEvents`)走:
 * 频道、事件名、`data` 对不上就编译不过 —— 表一改,用它的测试跟着红。缺 `ts` 时补 `defaultTs`。
 *
 * 故意违反类型的坏帧(测 hook 的防御)不走这里,各测试文件自己有一个 `malformed`。
 */
export function eventFrameMaker(defaultTs: string) {
	return (frame: WithoutTs<WsEventEnvelope>): WsEventEnvelope => ({ ts: defaultTs, ...frame });
}
