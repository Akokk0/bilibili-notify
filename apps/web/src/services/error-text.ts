/**
 * 一次失败要给人看的字 —— `message` 一句话,有逐条原因(`issues`)就接在后面。
 *
 * 服务端(ADR-0026)一句话的失败只有 `message`;一串检查意见(皮肤包 / 清单没通过装包门、
 * 女仆写的东西没过检查)是 `message` 一句概括 + `issues` 逐条。面板只读 `message` 的话,后一种
 * 会丢掉主人唯一能照着改的线索 —— 从前那串意见拼在 message 里一起来,现在分了格,这里把它
 * 们接回去。
 *
 * **按形状读,不 import `ApiError`**:测试里常把 `services/api` 整个换掉(自带一个假的 `ApiError`),
 * 这里若 `instanceof` 真类就认不出假的;而形状(`message` / `issues`)才是这里要的全部。
 */

/** 逐条原因的话。这次失败没带逐条原因(或根本不是一次带 `issues` 的失败)交空数组。 */
export function issueTextsOf(err: unknown): string[] {
	const issues = (err as { issues?: unknown } | null | undefined)?.issues;
	if (!Array.isArray(issues)) return [];
	const lines: string[] = [];
	for (const issue of issues) {
		const message = (issue as { message?: unknown } | null)?.message;
		if (typeof message !== "string" || message === "") continue;
		const path = (issue as { path?: unknown }).path;
		lines.push(Array.isArray(path) && path.length > 0 ? `${path.join(".")}：${message}` : message);
	}
	return lines;
}

/** 失败的全文:`message`,有逐条原因就接「：甲；乙」。 */
export function errorTextOf(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const lines = issueTextsOf(err);
	return lines.length > 0 ? `${message}：${lines.join("；")}` : message;
}
