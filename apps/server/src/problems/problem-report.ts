import { fail, ok, type Result } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";

/**
 * 问题上报的入口解析 —— 集成层、来源层、适配器层共用的一份规矩。
 *
 * 上报对拓展开放,交进来的就不受类型约束:这两口收 `unknown`,交回一份只含已知格的干净副本,或一句
 * 点名了哪一格的原因。问题表本身不校验形状(核心直写的人不经这一层)。
 */

/** 问题的 code:snake 风格,小写字母开头。 */
const PROBLEM_CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** 报的一条上报(解析后的干净副本):`message` 必填,别的给了就得合规矩。 */
export interface ProblemReport {
	externalId?: string;
	/** 适配器层才有的一格:带了就是关于这条连接的问题。 */
	connectionId?: string;
	code: string;
	message: string;
	recoveryMessage?: string;
	notify?: boolean;
}

/** 清的一条上报(解析后的干净副本):没有 `message` / `recoveryMessage`。 */
export interface ProblemResolve {
	externalId?: string;
	connectionId?: string;
	code: string;
	notify?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 两口共有的几格:`code` 必填且 snake,`notify` 给了就得是布尔,两个 id 给了就得是非空字符串。 */
type ProblemKeys = Pick<ProblemResolve, "externalId" | "connectionId" | "code" | "notify">;

function parseProblemKeys(report: unknown): Result<ProblemKeys> {
	if (!isRecord(report)) return fail("invalid", t("problem.report.issue.notRecord"));
	const code = report.code;
	if (typeof code !== "string") {
		return fail("invalid", t("problem.report.issue.notString", { cell: "code" }));
	}
	if (!PROBLEM_CODE.test(code)) {
		return fail("invalid", t("problem.report.issue.codePattern", { cell: "code" }));
	}
	const notify = report.notify;
	if (notify !== undefined && typeof notify !== "boolean") {
		return fail("invalid", t("problem.report.issue.notBoolean", { cell: "notify" }));
	}
	const externalId = report.externalId;
	if (externalId !== undefined && typeof externalId !== "string") {
		return fail("invalid", t("problem.report.issue.notString", { cell: "externalId" }));
	}
	if (externalId === "") {
		return fail("invalid", t("problem.report.issue.empty", { cell: "externalId" }));
	}
	const connectionId = report.connectionId;
	if (connectionId !== undefined && typeof connectionId !== "string") {
		return fail("invalid", t("problem.report.issue.notString", { cell: "connectionId" }));
	}
	if (connectionId === "") {
		return fail("invalid", t("problem.report.issue.empty", { cell: "connectionId" }));
	}
	return ok({
		...(externalId === undefined ? {} : { externalId }),
		...(connectionId === undefined ? {} : { connectionId }),
		code,
		...(notify === undefined ? {} : { notify }),
	});
}

/** 解析「报」的一口:成功交回干净副本,失败交回一句点名哪一格的原因。 */
export function parseProblemReport(report: unknown): Result<ProblemReport> {
	const keys = parseProblemKeys(report);
	if (!keys.ok) return keys;
	const raw = report as Record<string, unknown>;
	const message = raw.message;
	if (typeof message !== "string") {
		return fail("invalid", t("problem.report.issue.notString", { cell: "message" }));
	}
	if (message.trim() === "") {
		return fail("invalid", t("problem.report.issue.blank", { cell: "message" }));
	}
	const recoveryMessage = raw.recoveryMessage;
	if (recoveryMessage !== undefined && typeof recoveryMessage !== "string") {
		return fail("invalid", t("problem.report.issue.notString", { cell: "recoveryMessage" }));
	}
	if (typeof recoveryMessage === "string" && recoveryMessage.trim() === "") {
		return fail("invalid", t("problem.report.issue.blank", { cell: "recoveryMessage" }));
	}
	return ok({
		...(keys.externalId === undefined ? {} : { externalId: keys.externalId }),
		...(keys.connectionId === undefined ? {} : { connectionId: keys.connectionId }),
		code: keys.code,
		message,
		...(recoveryMessage === undefined ? {} : { recoveryMessage }),
		...(keys.notify === undefined ? {} : { notify: keys.notify }),
	});
}

/** 解析「清」的一口:同样的 id / code / notify 规矩,不看 `message`(清的一边没有它)。 */
export function parseProblemResolve(report: unknown): Result<ProblemResolve> {
	return parseProblemKeys(report);
}

/**
 * 被拒的上报里的 `code` 念给人听:不是字符串的只说类型,太长的截一段 —— 直接插第三方交来的值会把
 * 日志弄脏(甚至插进 `[object Object]`)。
 */
export function problemCodePreview(report: unknown): string {
	let code: unknown;
	try {
		code = isRecord(report) ? report.code : undefined;
	} catch {
		code = undefined;
	}
	if (typeof code !== "string") return `(${typeof code})`;
	return code.length > 64 ? `${code.slice(0, 64)}…` : code;
}

/** 被拒的问题上报给人看的一句话:已停下与形状 / 归属不对分开说。 */
export function problemRejectionReason(code: string, stopped: boolean, issue: string): string;
export function problemRejectionReason(code: string, stopped: true): string;
export function problemRejectionReason(code: string, stopped: boolean, issue?: string): string {
	return stopped
		? t("extension.report.problemRejectedStopped", { code })
		: t("extension.report.problemRejected", { code, reason: issue ?? "" });
}
