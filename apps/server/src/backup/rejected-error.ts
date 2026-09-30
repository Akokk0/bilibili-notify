import { type Failure, type FailureCode, fail } from "@bilibili-notify/internal";

/**
 * 备份被拒的原因,只有这两种(标准码表的子集,规矩见 docs/agents/conventions/failure-results.md):
 * `invalid` 这份东西不合规矩(不是我们的备份、内容被改坏、PIN 不对),`unsupported` 这个版本认不得
 * (备份来自更新的版本)。
 *
 * 注意 PIN 不对是 `invalid` 而**不是** `unauthorized`:`unauthorized` 对应 HTTP 403,而面板只把
 * 看板自己的 401 当成会话过期踢回登录框 —— 这里说的是「备份的 PIN」,跟看板的登录没有关系。
 */
export type BackupRejectionCode = Extract<FailureCode, "invalid" | "unsupported">;

/** 完整备份必须有 PIN —— 路由的闸与服务里的兜底说同一句话。 */
export const BACKUP_PIN_REQUIRED_MESSAGE = "完整备份必须设置 PIN";

/**
 * 导入 / 导出备份时**可预期**的拒收:用户递进来的文件或 PIN 有问题。`message` 是给人看的中文,
 * 路由靠 {@link BackupRejectedError.toFailure} 回给面板 —— 自带码,不嗅文案。
 *
 * 别的抛错(磁盘写失败、密钥库出错……)不是它,那是 bug 或环境的事,交给全局出错处理:
 * 原话进日志,客户端只拿一句固定的话,`String(err)` 里可能带路径。
 */
export class BackupRejectedError extends Error {
	readonly code: BackupRejectionCode;

	constructor(code: BackupRejectionCode, message: string) {
		super(message);
		this.name = "BackupRejectedError";
		this.code = code;
	}

	/** 回给面板的失败。 */
	toFailure(): Failure {
		return fail(this.code, this.message);
	}
}
