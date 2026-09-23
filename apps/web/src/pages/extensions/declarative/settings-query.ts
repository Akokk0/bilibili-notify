import type {
	ExtensionSettingsOp,
	ExtensionSettingsPatch,
	ExtensionSettingsResponse,
	ExtensionSettingsWriteResponse,
} from "@bilibili-notify/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extensionSettingsKey, extensionStatusKey } from "../../../hooks/useExtensions";
import { api } from "../../../services/api";
import { isConflict } from "./list-items";

/**
 * 一个 v2 拓展的设置怎么读、怎么写(ADR-0019 决策 35)—— 设置表单与列表那一节**共用这一份**。
 *
 * 走拓展自己的口 `/api/ext/:id/settings`,不走 `/api/globals`:那条老路整份写回,两发交错就丢一发,
 * `id` 与密钥占位也表达不了;现在它既不下发也不收这一格。读回来的是 `{ revision, values }` ——
 * 密钥格只有服务端算好的头尾(`{ masked }`),写的时候带上读到的版本号、只发这一下改了的那几步。
 *
 * 键住在 `hooks/useExtensions.ts`(WS 那条失效也从那儿取);这里转出去,照声明画的几处从这儿拿。
 */
export { extensionSettingsKey };

export function useExtensionSettings(extensionId: string) {
	return useQuery({
		queryKey: extensionSettingsKey(extensionId),
		queryFn: () => api.get<ExtensionSettingsResponse>(`/api/ext/${extensionId}/settings`),
	});
}

/**
 * 一发写带的东西 —— **走 variables**,不从闭包里拿:版本号是按下去那一刻屏幕上那份的,
 * 回调里要知道的也是**这一发**发了什么。调用处可以再带自己的几样(草稿、要亮出来的明文)。
 */
export interface SettingsWrite {
	revision: string;
	ops: ExtensionSettingsOp[];
}

/**
 * 写的那一发。写成之后在**这一发结束之前**把回应收进设置那一口,再交给 `onWritten`。
 *
 * 🔴 为什么非得在结束之前收好(不等 WS 那一帧、不等重读):
 * - 钮一松开,下一下就要带版本号。缓存里还是写之前那份的话,第二下拿着旧版本号撞 409 ——
 *   新建完立刻停用另一条、存完立刻再存,都是真实的手速。
 * - WS 那一帧与 HTTP 回应走两条连接,谁先到没保证。
 *
 * 收之前先**取消**在飞的重读:它可能是写之前就发出去的(窗口聚焦、上一帧 WS),晚到就把缓存
 * 盖回写之前的样子。取消了也不再重读 —— 回应就是写后的那份。视图那一口**照旧重读**:拓展的状态
 * 可能跟着设置变(停用了一条接入),在飞的那一发也可能是写之前的。
 *
 * **409**(版本号对不上 —— 别的标签页刚写过一笔):重读一遍。草稿、弹窗都留着,主人看一眼新的
 * 样子再按一次;拿着旧版本号硬写会把别人刚写的盖掉。
 */
export function useSettingsWrite<V extends SettingsWrite>(
	extensionId: string,
	onWritten?: (written: ExtensionSettingsWriteResponse, vars: V) => void,
) {
	const qc = useQueryClient();
	const key = extensionSettingsKey(extensionId);
	return useMutation({
		mutationFn: ({ revision, ops }: V) => {
			const body: ExtensionSettingsPatch = { revision, ops };
			return api.patch<ExtensionSettingsWriteResponse>(`/api/ext/${extensionId}/settings`, body);
		},
		onSuccess: async (written, vars) => {
			await qc.cancelQueries({ queryKey: key });
			const adopted: ExtensionSettingsResponse = {
				revision: written.revision,
				values: written.values,
			};
			qc.setQueryData(key, adopted);
			onWritten?.(written, vars);
			void qc.invalidateQueries({ queryKey: extensionStatusKey(extensionId) });
		},
		onError: (err) => {
			if (isConflict(err)) void qc.invalidateQueries({ queryKey: key });
		},
	});
}
