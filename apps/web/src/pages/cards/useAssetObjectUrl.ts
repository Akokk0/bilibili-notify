import { useEffect, useState } from "react";
import { api } from "../../services/api";

/**
 * 拉资产二进制并转 object URL 给缩略图用。`<img src="/api/cards/asset/:id">` 直连在
 * 桌面壳(token-header 鉴权)下会 401 —— img 标签不带自定义 header。改由 `api.blob`
 * 带鉴权头 fetch、createObjectURL 喂 img;assetId 变化 / 卸载时 revoke 旧 URL 防泄漏。
 * 空 id 返回 null(显示占位)。
 */
export function useAssetObjectUrl(assetId: string): string | null {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!assetId) {
			setUrl(null);
			return;
		}
		let cancelled = false;
		let objectUrl: string | null = null;
		api
			.blob(`/api/cards/asset/${assetId}`)
			.then((blob) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch(() => {
				if (!cancelled) setUrl(null);
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [assetId]);
	return url;
}
