/**
 * 系统页「重启一下」一节。
 *
 * 为什么要有它:BN 有几件事只有重启才生效 —— 主人自己放进 `<dataDir>/extensions/` 的
 * 拓展包、换掉一个已经跑着的拓展的代码、少数改完要重来的设置。而面板上原本**一个重启的
 * 入口都没有**:唯一那个「立即重启并应用」只在盘上装好了新版本时才出现。
 *
 * 🔴 **能不能重启由服务端判**(`GET /api/system`),这边不猜:进程退了谁把它拉起来是那台
 * 机器的事实(桌面外壳 / 容器的 `restart:` 策略 / 没人),面板上看不见。而判据说不能的时候
 * **要把原因写出来** —— 藏个按钮不解释,和功能坏了长得一模一样。
 */

import type {
	RestartAbility,
	RestartResponse,
	SystemInfoResponse,
} from "@bilibili-notify/contract";
import { Btn, GlassBox, HintNote, Icon, LoadingBlock } from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { SECTION_ACCENT } from "../../config/section-accents";
import { api } from "../../services/api";
import { type RestartWait, useRestartStore } from "../update/restart";

/** 与「立即重启并应用」同一组等待参数 —— 重启的代价两边一样。 */
const DEFAULT_WAIT: RestartWait = { intervalMs: 1_000, timeoutMs: 90_000 };

export interface RestartSectionProps {
	wait?: RestartWait;
}

/** 谁把它拉回来 —— 这句话决定了用户按下去之前心里有没有底。 */
function whoBringsItBack(ability: Extract<RestartAbility, { can: true }>): string {
	return ability.how === "desktop"
		? "桌面外壳盯着后端:它退出后外壳会自动拉起来,这一页跟着刷新。"
		: "容器要靠 docker 的 restart 策略把它拉起来 —— 没配 restart: unless-stopped 的话,重启完得自己 docker start 一次。";
}

/** 为什么不给按钮。**两种拉不起来的出路不一样**,所以不能合成一句「不支持」。 */
function whyNot(ability: Extract<RestartAbility, { can: false }>): string {
	return ability.reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了,tsx watch 只会停在那儿等文件变,没人把它拉起来。要重启就随便改一行代码存一下 —— 那本来就是一次重启。"
		: "这个进程退了没人拉(既没跑在桌面外壳里,也不在容器里),所以这里不给按钮:按下去 BN 就没了。要重启的话,在终端里停掉再起一次。";
}

export function RestartSection({ wait = DEFAULT_WAIT }: RestartSectionProps = {}) {
	const { view, begin, retry } = useRestartStore();
	const info = useQuery({
		queryKey: ["system"],
		queryFn: () => api.get<SystemInfoResponse>("/api/system"),
	});
	const restart = useMutation({
		// 回话里带着要换掉的是哪个进程(startedAt)与现在这一版 —— 之后只有 startedAt
		// 和它不同的回答才算新进程:旧进程优雅停机时还能连上好几秒。
		mutationFn: () => api.post<RestartResponse>("/api/system/restart", {}),
		onSuccess: ({ startedAt, version }) =>
			begin({ before: startedAt, target: version, mode: "restart" }, wait),
	});

	// 问不到判据(老载荷 / 这一节没挂)→ 整节不渲染。摆一个按不动的按钮比不摆更糟。
	if (info.isError || !info.data) return null;

	const ability = info.data.restart;
	// 只认自己按出来的那一次:更新那条路的等待归更新那一节显示。
	const mine = view?.intent.mode === "restart" ? view : null;

	return (
		<GlassBox
			title="重启一下 · restart"
			subtitle="手放进去的拓展包、换掉的拓展代码,要重启一次才算数"
			accent={SECTION_ACCENT.system}
			icon={<Icon.refresh size={14} />}
		>
			<div className="flex flex-col gap-4">
				<p className="text-bn-xs leading-relaxed text-bn-text-tertiary">
					重启这几秒推送会断,直播监听回来后自己重连;正在发的那条会等它发完再关。
					{ability.can ? ` ${whoBringsItBack(ability)}` : ""}
				</p>

				{ability.can ? null : <HintNote tone="neutral">{whyNot(ability)}</HintNote>}

				{mine?.kind === "waiting" ? (
					<LoadingBlock variant="inset" label="正在重启" hint="服务回来后这一页会自动刷新。" />
				) : null}

				{mine?.kind === "fell-back" ? (
					<HintNote tone="neutral">
						重启完了,不过跑起来的是 <strong>{mine.version}</strong>,不是刚才那份{" "}
						{mine.intent.target} —— 盘上装着的另一份载荷被选上了。日志里 <code>[boot]</code>{" "}
						开头那行写着为什么。
					</HintNote>
				) : null}

				{mine?.kind === "timed-out" ? (
					<HintNote tone="neutral" className="flex flex-wrap items-center gap-2">
						<span>
							等了 {Math.round(wait.timeoutMs / 1000)} 秒还没等到服务回来。多半是没人把它拉起来 ——
							容器看 <code>restart</code> 策略,桌面版看启动器日志。
						</span>
						<Btn variant="outline" size="sm" onClick={retry}>
							再等等
						</Btn>
					</HintNote>
				) : null}

				{restart.isError ? (
					<HintNote tone="neutral">没能发出重启指令:{restart.error.message}</HintNote>
				) : null}

				{ability.can ? (
					<div className="flex flex-wrap gap-2">
						<Btn
							variant="outline"
							size="sm"
							disabled={restart.isPending || mine?.kind === "waiting"}
							onClick={() => restart.mutate()}
						>
							重启 BN
						</Btn>
					</div>
				) : null}
			</div>
		</GlassBox>
	);
}
