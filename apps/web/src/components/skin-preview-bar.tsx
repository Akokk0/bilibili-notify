import { Btn } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../services/api";
import { useSkinStore } from "../store/skin";

/**
 * 试穿浮条:preview 非空时悬在页面顶部中央。「应用」把预览落成服务端 active,
 * 「取消」清预览回真实状态;刷新页面预览自然消失(不落盘)。
 */
export function SkinPreviewBar() {
	const preview = useSkinStore((s) => s.preview);
	const qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);

	const apply = useMutation({
		// 要发的东西必须走 variables —— preview 闭包在 onMutate/onSuccess 时序下靠不住。
		mutationFn: (id: string) => api.put<{ ok: boolean }>("/api/skins/active", { id }),
		onSuccess: (_data, id) => {
			const applied = useSkinStore.getState().preview;
			if (applied && applied.id === id) {
				useSkinStore.getState().setActive(applied);
			}
			useSkinStore.getState().setPreview(null);
			setError(null);
			void qc.invalidateQueries({ queryKey: ["skins"] });
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	if (!preview) return null;
	return (
		<div className="fixed inset-x-0 top-3 z-500 flex justify-center px-4">
			<div className="bn-glass-strong flex items-center gap-3 rounded-bn-pill px-4 py-2 shadow-bn-elev">
				<span className="text-[12.5px] text-bn-text-primary">
					正在试穿<b>「{preview.manifest.name}」</b>
					<span className="ml-1 text-bn-text-secondary">仅本页生效,刷新即还原</span>
				</span>
				{error ? <span className="text-[12px] text-bn-danger">{error}</span> : null}
				<Btn size="sm" onClick={() => apply.mutate(preview.id)} disabled={apply.isPending}>
					{apply.isPending ? "应用中…" : "应用"}
				</Btn>
				<Btn
					size="sm"
					variant="outline"
					onClick={() => useSkinStore.getState().setPreview(null)}
					disabled={apply.isPending}
				>
					取消
				</Btn>
			</div>
		</div>
	);
}
