import { skinAssetUrl, useCurrentSkinMode } from "./skin-root";

/**
 * 皮肤 hero 横幅:当前模式的 manifest 给了 banner 才渲染,挂在 Dashboard 首页
 * 顶部。默认装没有横幅 —— 这是纯皮肤能力,不是产品固定结构。
 */
export function SkinBanner() {
	const current = useCurrentSkinMode();
	const banner = current?.mode.banner;
	if (!current || !banner) return null;
	return (
		<div
			className="overflow-hidden rounded-bn-card shadow-bn-card"
			style={{ height: banner.height }}
		>
			<img
				src={skinAssetUrl(current.id, banner.image)}
				alt=""
				className="h-full w-full"
				style={{
					objectFit: banner.fit ?? "cover",
					objectPosition: banner.position ?? "center",
				}}
			/>
		</div>
	);
}
