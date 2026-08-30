import { Btn, GlassBox, Icon } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SECTION_ACCENT } from "../../config/section-accents";
import { api } from "../../services/api";
import { useOnboardingReopen } from "../../store/onboarding";

/**
 * 系统页「新手指引」一节 —— 三态 `onboarding.skipped` 的回头路。
 *
 * 选「老用户跳过」/点「跳过指引」/毕业之后整个导览不渲染,这里是唯一的重开
 * 入口。两半拍:配置写回 `false`(PATCH + invalidate 既有通道),然后发
 * reopen 信号让 TourCompanion 把这台浏览器上收着的卡展开 —— 顺序要紧,配置
 * 没写上就展开,导览会因 skipped=true 渲染不出来,按钮看起来像坏了。
 */
export function OnboardingReopenSection() {
	const qc = useQueryClient();
	const reopen = useOnboardingReopen((s) => s.reopen);
	const { mutate, isPending } = useMutation({
		mutationFn: () => api.patch("/api/globals", { onboarding: { skipped: false } }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["globals"] });
			reopen();
		},
	});
	return (
		<GlassBox
			title="新手指引 · onboarding"
			subtitle="五步导览:登录 → 适配器 → 目标 → 测试 → 订阅 · 跳过或毕业后从这里重开"
			accent={SECTION_ACCENT.system}
			icon={<Icon.sparkle size={14} />}
		>
			<div className="flex flex-wrap items-center gap-3">
				<div className="text-bn-sm leading-relaxed text-bn-text-secondary">
					重开后左下角出现导览小卡,按当前配置进度接着带你做;随时可再跳过。
				</div>
				<Btn variant="outline" size="sm" disabled={isPending} onClick={() => mutate()}>
					重新开启指引
				</Btn>
			</div>
		</GlassBox>
	);
}
