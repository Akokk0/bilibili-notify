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
 *
 * **换内容就换一个新框,绝不在已插入的框上改 `srcdoc`**(2026-09-17 真机反馈):改 `srcdoc`
 * 是一次子框导航,浏览器把它记进整页的历史 —— 切几次卡种,「返回」就得点几次,前几下
 * 退的都是这个框。新插入的框,首次导航是替换它的初始空白页,不占历史。新框在后面藏着画,
 * `load` 了才顶上来、旧框才撤 —— 编辑器那条「重画期间旧图不撤」的规矩照旧成立。
 */

import { useEffect, useRef, useState } from "react";

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
	/** 已经画好、正露着的那份。新的那份 `load` 了才换成它。 */
	const [ready, setReady] = useState<string | null>(null);

	/**
	 * 每份 HTML 一个稳定的框号,当 React key 用 —— 同一份内容从「藏着」变成「露着」时
	 * 必须还是**同一个框**,换个 key 就又是一次新插入、又得重画一遍。
	 */
	const ids = useRef(new Map<string, number>());
	const seq = useRef(0);
	const idOf = (doc: string): number => {
		let id = ids.current.get(doc);
		if (id === undefined) {
			seq.current += 1;
			id = seq.current;
			ids.current.set(doc, id);
		}
		return id;
	};
	// 只留还在台上的那两份的号,别让一路改下来的每一版草稿都攒在这张表里。
	useEffect(() => {
		for (const doc of ids.current.keys()) {
			if (doc !== ready && doc !== html) ids.current.delete(doc);
		}
	}, [ready, html]);

	const docs = ready === null || ready === html ? [html] : [ready, html];
	const frameStyle = {
		width,
		height: Math.round(height / scale),
		transform: scale < 1 ? `scale(${scale})` : undefined,
		transformOrigin: "top left",
	};

	return (
		<div
			// 不给底色:预览那份 HTML 的页面底是透明的(卡外那片白不属于这张卡),
			// 底板的颜色从卡后面透上来才对。
			className="relative overflow-hidden rounded-bn-sm shadow-md"
			style={{ width: shown, height }}
		>
			{docs.map((doc) => {
				const live = doc === ready;
				return (
					<iframe
						key={idOf(doc)}
						// `srcDoc` + 空 sandbox:不给脚本、不给同源(见文件头)。
						srcDoc={doc}
						sandbox=""
						title={title}
						onLoad={live ? undefined : () => setReady(doc)}
						aria-hidden={live ? undefined : true}
						className={`block border-0 ${live ? "" : "invisible absolute left-0 top-0"}`}
						style={frameStyle}
					/>
				);
			})}
		</div>
	);
}
