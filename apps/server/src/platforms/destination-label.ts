import type { DestinationRef } from "@bilibili-notify/internal";

/** 日志里认一个去向用的短标签:端点取它的 id,会话取 `scope:address`(发送口不再有目标 id)。 */
export function describeDestination(destination: DestinationRef): string {
	return destination.kind === "endpoint"
		? destination.id
		: `${destination.scope}:${destination.address}`;
}
