import { redactLogCall, scrubSecrets } from "./redact.js";

/**
 * 还没有 logger 时的兜底输出(启动早期、总线没接日志时):直写 stdout / stderr 的路径绕过了
 * `wrapLogger` 的入口打码,凭证会原样落进 docker logs / 桌面后台输出。这里用同一份打码口
 * (`redactLogCall` / `scrubSecrets`)过一遍再写,不在别处抄正则。
 * 这些兜底不进面板日志页与归档 —— 那时 logger 还不在。
 */

/** 等价 `console.error(msg, ...args)`,msg 与参数(含 `Error`)先打码。 */
export function consoleErrorRedacted(msg: string, ...args: readonly unknown[]): void {
	const safe = redactLogCall(msg, args);
	console.error(safe.msg, ...safe.args);
}

/** 等价 `process.stderr.write(\`${line}\n\`)`,整行先打码。 */
export function stderrLineRedacted(line: string): void {
	process.stderr.write(`${scrubSecrets(line)}\n`);
}
