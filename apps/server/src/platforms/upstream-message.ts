/** 上游抛的错取它的话(`Error.message`,不是 `String(err)`);不是 Error 或没话就说没说原因。 */
export function upstreamMessage(err: unknown): string {
	return err instanceof Error && err.message ? err.message : "上游没说原因";
}
