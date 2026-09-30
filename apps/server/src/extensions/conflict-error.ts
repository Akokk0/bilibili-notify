import { type Failure, fail } from "@bilibili-notify/internal";

/**
 * 装 / 卸 / 换代码时**可预期的拒绝**:撞上了盘上或装载器里的当前状态 —— 目标是 devtools 链进来的
 * 工作树(往里写就是往 git 仓库里写)、没有等着换上的新代码、开关关着换不得。`message` 是给主人
 * 看的中文,路由靠 {@link ExtensionConflictError.toFailure} 回给面板 —— 码是 `conflict`,不嗅文案。
 *
 * 别的抛错(磁盘写失败、换代码时的 bug)不是它,交给全局出错处理:原话进日志,客户端只拿一句固定
 * 的话。路由只接这一种,其余原样往外抛。规矩见 docs/agents/conventions/failure-results.md。
 */
export class ExtensionConflictError extends Error {
	readonly code = "conflict" as const;

	constructor(message: string) {
		super(message);
		this.name = "ExtensionConflictError";
	}

	/** 回给面板的失败。 */
	toFailure(): Failure {
		return fail(this.code, this.message);
	}
}
