/**
 * 强调色派生的两块表面样式 —— `GlassPanel` 与 `GlassBox` 共用。
 *
 * 这两件长得不一样(尺寸、留白、标题排布各是各的),但「一抹角光 + 一枚图标胶囊」
 * 是同一套配方,此前在两个文件里逐字符各写一遍。同包内并排放着两份手抄的百分比,
 * 改一处就得记得另一处 —— 而它招来的漂移已经在别处发生了:同样是 135° 的图标
 * 胶囊,`atoms.tsx` 写 87%、`UpDialog.tsx` 写 67%。
 *
 * 只收百分比这类**配方**;尺寸留在各自的调用点(`h-7.5` 与 `h-24` 是真的不同)。
 */

import type { CSSProperties } from "react";

/** 右上角那抹角光。 */
export function accentRadial(accent: string): CSSProperties {
	return {
		background: `radial-gradient(circle at top right, color-mix(in srgb, ${accent} 12%, transparent), transparent 70%)`,
	};
}

/** 标题旁那枚图标胶囊的底与投影。 */
export function accentChip(accent: string): CSSProperties {
	return {
		background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 80%, transparent))`,
		boxShadow: `0 4px 12px color-mix(in srgb, ${accent} 33%, transparent)`,
	};
}
