/**
 * 「装完那句话」—— 传包装与从市场装**共用**这一块(装完的回答是同一个形状)。
 *
 * 三种结局的出路完全不同:热装好了(什么都不用做)、盖掉了一份已经跑着的(得重启一次,而
 * 这台机器给不给按钮还要看)、装失败(原因由调用方另行摆出来,不在这里)。
 *
 * ⛔ **那颗重启按钮只在这里、只在这一刻出现**(ADR-0005 决策 22):面板上没有常驻的重启
 * 入口 —— 重启是**刚做完这件事**的后果,不是一个随时可按的动作。这台机器上按了回不来
 * (开发版 / 裸跑)就不给按钮,但要把原因写出来。
 */

import type { ExtensionInstallResponse, RestartResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, HintNote, LoadingBlock } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import {
	DEFAULT_RESTART_WAIT,
	type RestartWait,
	useRestartStore,
} from "../../components/update/restart";
import { api } from "../../services/api";

/** 重启回不来的那两档各自的出路不一样,所以不能合成一句「不支持」。 */
function whyNoButton(reason: "source-run" | "unsupervised"): string {
	return reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了 tsx watch 只等文件变,没人把它拉起来 —— 随便改一行代码存一下,那本来就是一次重启。"
		: "这个进程退了没人拉(既没跑在桌面外壳里,也不在容器里)—— 自己在终端里停掉再起一次。";
}

export interface ExtensionInstallOutcomeProps {
	done: ExtensionInstallResponse | null;
	/** 等待参数,只有测试会给。 */
	wait?: RestartWait;
}

export function ExtensionInstallOutcome({
	done,
	wait = DEFAULT_RESTART_WAIT,
}: ExtensionInstallOutcomeProps) {
	const { view, begin } = useRestartStore();
	const restart = useMutation({
		mutationFn: () => api.post<RestartResponse>("/api/system/restart", {}),
		onSuccess: ({ startedAt, version }) =>
			begin({ before: startedAt, target: version, mode: "restart" }, wait),
	});
	const waiting = view?.intent.mode === "restart" && view.kind === "waiting";

	return (
		<>
			{done && !done.needsRestart ? (
				<HintNote tone="success">
					<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
					装好了,已经在跑 —— 开关在它自己那张卡上。
				</HintNote>
			) : null}

			{done?.needsRestart ? (
				<HintNote tone="neutral" className="flex flex-wrap items-center gap-2">
					<span>
						<strong className="text-bn-text-secondary">{done.name}</strong> 换成了 {done.version}
						,但它的旧代码已经在这个进程里跑着、换不掉 ——{" "}
						<strong className="text-bn-text-secondary">重启一次</strong>才会用上新的。
						{done.restart.can ? "" : ` ${whyNoButton(done.restart.reason)}`}
					</span>
					{done.restart.can ? (
						<Btn
							variant="outline"
							size="sm"
							disabled={restart.isPending || waiting}
							onClick={() => restart.mutate()}
						>
							重启一次
						</Btn>
					) : null}
				</HintNote>
			) : null}

			{waiting ? (
				<LoadingBlock variant="inset" label="正在重启" hint="服务回来后这一页会自动刷新。" />
			) : null}

			{restart.isError ? (
				<ErrorNote size="sm">没能发出重启指令:{restart.error.message}</ErrorNote>
			) : null}
		</>
	);
}
