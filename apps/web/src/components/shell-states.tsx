/**
 * Shell-level Empty / Loading / Error overlays — port of the variation-ac
 * stateMode branches. Shown by App.tsx when /api/health hasn't responded
 * yet or has fatal-erred, OR when the user has no subs and no targets
 * (empty bootstrap).
 */

import { useNavigate } from "react-router-dom";
import { Btn } from "./atoms";

export function ShellLoading() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-7 py-20">
			<div
				className="bn-anim-spin h-10 w-10 rounded-full border-4 border-bn-border-subtle"
				style={{ borderTopColor: "#FB7299" }}
			/>
			<div className="text-[13px] text-bn-text-tertiary">正在加载订阅列表...</div>
			<div className="text-[11px] text-bn-text-secondary">女仆正在向 B 站打招呼 (｡･ω･｡)ﾉ</div>
		</div>
	);
}

export function ShellError({ message, onRetry }: { message: string; onRetry: () => void }) {
	const navigate = useNavigate();
	return (
		<div className="px-7 pt-5">
			<div
				className="rounded-lg border bg-bn-danger-soft p-4 backdrop-blur-sm"
				style={{ borderColor: "rgba(239,68,68,0.2)", borderLeft: "3px solid #ef4444" }}
			>
				<div className="mb-1 text-[13px] font-bold text-bn-danger-text">
					无法连接到 Bilibili Notify 后端
				</div>
				<div className="text-xs leading-relaxed text-bn-danger-text">
					错误：
					<code className="rounded bg-bn-code-bg px-1.5 py-0.5">{message}</code>
					<br />
					主人，后端可能未启动，或被代理拦截了。请检查 standalone 服务是否在运行～
				</div>
				<div className="mt-3 flex gap-2">
					<Btn variant="primary" size="sm" onClick={onRetry}>
						重试
					</Btn>
					<Btn variant="outline" size="sm" onClick={() => navigate("/system")}>
						前往系统
					</Btn>
				</div>
			</div>
		</div>
	);
}
