import {
	type ConfigScope,
	type Failure,
	type FailureCode,
	fail,
	type Issue,
	issuesFromZod,
} from "@bilibili-notify/internal";

/**
 * 配置写入被拒的原因,只有这三种(标准码表的子集,规矩见 docs/agents/conventions/failure-results.md):
 * `invalid` 内容不合规矩,`not_found` 要改的那一条不存在,`conflict` 与当前状态冲突(托管的、还被用着的)。
 */
export type ConfigFailureCode = Extract<FailureCode, "invalid" | "not_found" | "conflict">;

/** 面板上一块配置叫什么 —— 拼进给人看的那句话。 */
const SCOPE_LABEL: Record<ConfigScope, string> = {
	globals: "全局设置",
	"integration-settings": "集成的设置",
	subscriptions: "订阅",
	connections: "连接",
	targets: "推送目标",
	secrets: "密钥",
};

/** 顶上那句话里最多摊几条原因;全部原因在 `issues` 里。 */
const SUMMARY_LIMIT = 3;

/** 一条原因摊成「路径：话」,路径落在根上的只留话。 */
function lineOf(issue: Issue): string {
	return issue.path && issue.path.length > 0
		? `${issue.path.join(".")}：${issue.message}`
		: issue.message;
}

function summarize(issues: readonly Issue[]): string {
	const shown = issues.slice(0, SUMMARY_LIMIT).map(lineOf).join("；");
	return issues.length > SUMMARY_LIMIT ? `${shown}；……共 ${issues.length} 处` : shown;
}

/**
 * 一次配置写入被拒。**路由靠 `code` 挑状态码、靠 `toFailure()` 回给面板,不再嗅文案** ——
 * 从前 `issues` 是 `unknown`,路由拿其中一句英文去比对,改一个字就静默变成 400/500。
 *
 * `message` 是给人看的中文(面板原样显示,日志里也是它);逐格原因在 `issues`(可空)。
 * `scope` 只留作数据,不上线。
 */
export class ConfigValidationError extends Error {
	readonly scope: ConfigScope;
	readonly code: ConfigFailureCode;
	readonly issues: Issue[];

	constructor(scope: ConfigScope, code: ConfigFailureCode, message: string, issues: Issue[] = []) {
		super(message);
		this.name = "ConfigValidationError";
		this.scope = scope;
		this.code = code;
		this.issues = issues;
	}

	/** 内容不合规矩(`issues` 是逐格原因,可空)。 */
	static invalid(scope: ConfigScope, message: string, issues: Issue[] = []): ConfigValidationError {
		return new ConfigValidationError(scope, "invalid", message, issues);
	}

	/** 要改的那一条不存在。 */
	static notFound(scope: ConfigScope, message: string): ConfigValidationError {
		return new ConfigValidationError(scope, "not_found", message);
	}

	/** 与当前状态冲突:托管的不许动、还被别处引用着。 */
	static conflict(scope: ConfigScope, message: string): ConfigValidationError {
		return new ConfigValidationError(scope, "conflict", message);
	}

	/**
	 * zod 校验没过。逐格原因原样进 `issues`(zod 的英文默认话在这里可以),顶上那句是中文,
	 * 摊前几条让人不点开也知道错在哪。`subject` 缺省是这一块配置的名字,读盘时传文件名。
	 * `prefix` 接在每条原因的路径前(盘上数组第几行)。
	 */
	static fromZod(
		scope: ConfigScope,
		error: Parameters<typeof issuesFromZod>[0],
		opts: { subject?: string; prefix?: (string | number)[] } = {},
	): ConfigValidationError {
		return ConfigValidationError.fromIssues(scope, issuesFromZod(error), opts);
	}

	/** 一串逐格原因(zod 之外的核法交上来的)→ 与 {@link fromZod} 同一种话。`prefix` 同上。 */
	static fromIssues(
		scope: ConfigScope,
		raw: readonly Issue[],
		opts: { subject?: string; prefix?: (string | number)[] } = {},
	): ConfigValidationError {
		const prefix = opts.prefix ?? [];
		const issues =
			prefix.length > 0
				? raw.map((i) => ({ ...i, path: [...prefix, ...(i.path ?? [])] }))
				: [...raw];
		const subject = opts.subject ?? SCOPE_LABEL[scope];
		return ConfigValidationError.invalid(
			scope,
			`${subject}有 ${issues.length} 格不合法：${summarize(issues)}`,
			issues,
		);
	}

	/** 回给面板的失败:没有逐格原因就不带 `issues`。 */
	toFailure(): Failure {
		return fail(this.code, this.message, this.issues.length > 0 ? { issues: this.issues } : {});
	}
}
