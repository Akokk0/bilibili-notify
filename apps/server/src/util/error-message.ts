/**
 * 写日志用:是 `Error` 取它的 `message`,不是就整个转成字符串。
 * 给人看的失败话(回给面板、写进 `fail()` 的 `message`)用 `platforms/upstream-message.ts` 的 `upstreamMessage`。
 */
export function errorMessageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
