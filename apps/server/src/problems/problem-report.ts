/**
 * 问题上报的入口校验 —— 集成层、来源层(以及之后的适配器层)共用的一份规矩:
 * `code` 是 snake 风格,`message` / `recoveryMessage` 不许空白,`externalId` 不许空串。
 * 问题表本身不校验形状(核心直写的人不经这一层),校验长在各自的上下文入口。
 */

/** 问题的 code:snake 风格,小写字母开头。 */
const PROBLEM_CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** 报或清的一条上报里要过校验的几格;清的一边没有 `message`。 */
export interface ProblemReport {
	externalId?: string;
	code: string;
	message?: string;
	recoveryMessage?: string;
}

/** 这条上报形状对不对:对就是 `undefined`,不对回一句点名了哪一格的原因(给日志用)。 */
export function problemReportIssue(problem: ProblemReport): string | undefined {
	if (!PROBLEM_CODE.test(problem.code)) return "code 不是 snake 风格";
	if (problem.externalId === "") return "externalId 是空串";
	if (problem.message !== undefined && problem.message.trim() === "") return "message 是空白";
	if (problem.recoveryMessage !== undefined && problem.recoveryMessage.trim() === "") {
		return "recoveryMessage 是空白";
	}
	return undefined;
}
