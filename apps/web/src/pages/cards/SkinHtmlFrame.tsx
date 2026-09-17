/**
 * 一份卡片 HTML 的**隔离预览框** —— 编辑器的实时预览与聊天里卡片工坊的预览共用。
 *
 * 共用的理由是那条 sandbox 规矩:**不给 `allow-scripts`,也不给 `allow-same-origin`**。
 * 皮肤里能写自定义 HTML 与 CSS,放开任一条就是让皮肤作者在主人面板里执行代码、读会话
 * —— 两处各写一份的话,总有一处哪天被人「顺手」加上。
 *
 * iframe 里按**卡的真实宽度**排版,再整张缩到 `usable` 以内:直接把 iframe 调窄等于让
 * 皮肤在一个它没见过的宽度上重新排,看到的就不是那张卡了。高度是固定的视口,卡比它高
 * 就在框里滚 —— 隔离的 iframe 量不到内容高度。
 */

export function SkinHtmlFrame({
	html,
	width,
	usable,
	height,
	title,
}: {
	html: string;
	/** 卡宽 px(服务端回的那个)。 */
	width: number;
	/** 这一栏能给多宽 px;比卡窄就整张按比例缩。 */
	usable: number;
	/** 视口高度 px。 */
	height: number;
	title: string;
}) {
	const shown = Math.min(width, Math.max(usable, 1));
	const scale = shown / width;
	return (
		<div
			// 不给底色:预览那份 HTML 的页面底是透明的(卡外那片白不属于这张卡),
			// 底板的颜色从卡后面透上来才对。
			className="overflow-hidden rounded-bn-sm shadow-md"
			style={{ width: shown, height }}
		>
			<iframe
				// `srcDoc` + 空 sandbox:不给脚本、不给同源(见文件头)。
				srcDoc={html}
				sandbox=""
				title={title}
				className="block border-0"
				style={{
					width,
					height: Math.round(height / scale),
					transform: scale < 1 ? `scale(${scale})` : undefined,
					transformOrigin: "top left",
				}}
			/>
		</div>
	);
}
