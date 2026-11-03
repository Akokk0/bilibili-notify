import { type Failure, type FailureCode, fail } from "@bilibili-notify/internal";
import { t as serverText } from "../i18n/index.js";

/**
 * 失败那一句话怎么写 —— 两件事路由里到处要用:一串检查意见怎么变成 `message` + `issues`,
 * 「还有谁在用」怎么并进 `message`(ADR-0026 决策 6:`errors: string[]` / `referencedBy` / `usedBy`
 * 不再各占一格,只剩 `message` 与 `issues`)。规矩见 docs/agents/conventions/failure-results.md。
 */

/**
 * 一串检查意见 → 失败。**只有一句** → 就是 `message`,不带 `issues`(话已经说全了,再摆一份是重复);
 * **不止一句** → `message` 一句中文概括(`subject` 没通过检查、共几条),逐条意见放 `issues`,面板逐条摆出来。
 *
 * `reasons` 是检查器已经拼好的话(如 `cards.live.width: …`),这里不再拆路径:硬拆是在猜格式。
 * 没有意见(不该发生)也回 `message`,免得回一个空话的失败。
 *
 * `listSingle`:只有一句时也摆成「概括 + 逐条」。意见本身离了上下文说不清是谁的时候要用
 * (女仆写出来的东西没过检查,一句「输出不是合法 JSON」不知道在说什么输出)。
 */
export function failureOfChecks(
	code: FailureCode,
	subject: string,
	reasons: readonly string[],
	options: { listSingle?: boolean } = {},
): Failure {
	const [only] = reasons;
	if (reasons.length === 1 && only !== undefined && !options.listSingle) return fail(code, only);
	if (reasons.length === 0)
		return fail(code, serverText("service.util.failure-text.text.1", { value0: subject }));
	return fail(
		code,
		serverText("service.util.failure-text.text.2", { value0: subject, count: reasons.length }),
		{
			issues: reasons.map((message) => ({ message })),
		},
	);
}

/** 「还有谁在用」那句话里最多点几个名字;再多的只报个数,全列出来会把一条错误变成一面墙。 */
const USERS_SHOWN = 3;

/** 几个用家点名:不多于 {@link USERS_SHOWN} 个全列,多了列前几个再接「等 N 处」。 */
export function listUsers(users: readonly string[]): string {
	const shown = users.slice(0, USERS_SHOWN).join("、");
	return users.length > USERS_SHOWN
		? serverText("service.util.failure-text.text.3", { value0: shown, count: users.length })
		: shown;
}

/** 「还有 3 处在用：全局默认、某 UP、另一 UP」—— 拼进 `message`,不占一格自己的字段。 */
export function describeUsers(users: readonly string[]): string {
	return serverText("service.util.failure-text.text.4", {
		count: users.length,
		value1: listUsers(users),
	});
}
