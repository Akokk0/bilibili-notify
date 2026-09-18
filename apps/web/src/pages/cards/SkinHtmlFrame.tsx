/**
 * 一份卡片 HTML 的**隔离预览框** —— 编辑器的实时预览与聊天里卡片工坊的预览共用。
 *
 * 共用的理由是那条 sandbox 规矩:**只给 `allow-same-origin`,绝不给 `allow-scripts`**。
 * 皮肤里能写自定义 HTML 与 CSS,给了脚本就是让皮肤作者在主人面板里执行代码;而同源 +
 * 脚本两条都给,框里的脚本能把 sandbox 属性自己摘掉,等于没有沙箱 —— 两处各写一份的话,
 * 总有一处哪天被人「顺手」加上。
 *
 * **同源是为了量卡高**(2026-09-17 主人拍板):不给同源时外层读不到框里的文档,框只能按
 * 固定视口开,长卡在框里出滚动条。只给同源不给脚本,框里什么代码都跑不起来(`<script>`、
 * 事件属性真 Chrome 验过都不执行),而皮肤能发请求的口子 —— `url()`、外链的 `src` ——
 * 在装包门就拒掉了,所以带会话的请求也发不出去。
 *
 * 量的是框里**文档根**(`html`)的高度 —— 与出图裁图量的是同一个元素。`load` 时量一次,
 * 字体就绪后再量一次(字体换上来会重排)。量不到就退回固定视口,卡在框里滚。
 *
 * iframe 里按**卡的真实宽度**排版,再整张缩到 `usable` 以内:直接把 iframe 调窄等于让
 * 皮肤在一个它没见过的宽度上重新排,看到的就不是那张卡了。
 *
 * **换内容就换一个新框,绝不在已插入的框上改 `srcdoc`**(2026-09-17 真机反馈):改 `srcdoc`
 * 是一次子框导航,浏览器把它记进整页的历史 —— 切几次卡种,「返回」就得点几次,前几下
 * 退的都是这个框。新插入的框,首次导航是替换它的初始空白页,不占历史。新框在后面藏着画,
 * `load` 了(量完高)才顶上来、旧框才撤 —— 编辑器那条「重画期间旧图不撤」的规矩照旧成立,
 * 外框的高度也在那一刻才换。
 */

import { useEffect, useRef, useState } from "react";

/** 已经画好、正露着的那份。`height` 是量到的文档高度(框内 px),`null` = 没量到。 */
interface Ready {
	doc: string;
	height: number | null;
}

/** 框里文档根的高度,往上取整(比内容矮半个像素,框里就又出滚动条了)。量不到回 `null`。 */
function contentHeight(frame: HTMLIFrameElement): number | null {
	const h = frame.contentDocument?.documentElement?.getBoundingClientRect().height;
	return h && h > 0 ? Math.ceil(h) : null;
}

export function SkinHtmlFrame({
	html,
	width,
	usable,
	fallbackHeight,
	title,
	onDocument,
}: {
	html: string;
	/** 卡宽 px(服务端回的那个)。 */
	width: number;
	/** 这一栏能给多宽 px;比卡窄就整张按比例缩。 */
	usable: number;
	/** 量到卡高之前(以及万一量不到时)的视口高度 px。 */
	fallbackHeight: number;
	title: string;
	/**
	 * 这一份画好了,把框里的文档交出去 —— 画布要知道这一场**真画出了哪些块**。
	 *
	 * 只在 `load` 那一刻交一次就够:块画不画由数据与 `showIf` 定,字体到齐只会改排版、
	 * 不会让某一块凭空出现或消失。(将来要量高就另说 —— 那得跟着字体再量一遍。)
	 */
	onDocument?: (doc: Document) => void;
}) {
	const shown = Math.min(width, Math.max(usable, 1));
	const scale = shown / width;
	const [ready, setReady] = useState<Ready | null>(null);

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
			if (doc !== ready?.doc && doc !== html) ids.current.delete(doc);
		}
	}, [ready, html]);

	const onLoad = (doc: string, frame: HTMLIFrameElement) => {
		setReady({ doc, height: contentHeight(frame) });
		const now = frame.contentDocument;
		if (now) onDocument?.(now);
		frame.contentDocument?.fonts?.ready.then(() => {
			const height = contentHeight(frame);
			// 这时它可能已经被下一份顶掉了(框撤了就量不到),那就不关它的事了。
			if (height === null) return;
			setReady((r) => (r?.doc === doc && r.height !== height ? { doc, height } : r));
		});
	};

	const docs = ready === null || ready.doc === html ? [html] : [ready.doc, html];
	const viewport = ready?.height ?? Math.round(fallbackHeight / scale);
	const boxHeight = ready?.height != null ? Math.round(ready.height * scale) : fallbackHeight;

	return (
		<div
			// 不给底色:预览那份 HTML 的页面底是透明的(卡外那片白不属于这张卡),
			// 底板的颜色从卡后面透上来才对。
			className="relative overflow-hidden rounded-bn-sm shadow-md"
			style={{ width: shown, height: boxHeight }}
		>
			{docs.map((doc) => {
				const live = doc === ready?.doc;
				return (
					<iframe
						key={idOf(doc)}
						// `srcDoc` + 只给同源:不给脚本(见文件头)。
						srcDoc={doc}
						sandbox="allow-same-origin"
						title={title}
						onLoad={live ? undefined : (e) => onLoad(doc, e.currentTarget)}
						aria-hidden={live ? undefined : true}
						className={`block border-0 ${live ? "" : "invisible absolute left-0 top-0"}`}
						style={{
							width,
							height: live ? viewport : Math.round(fallbackHeight / scale),
							transform: scale < 1 ? `scale(${scale})` : undefined,
							transformOrigin: "top left",
						}}
					/>
				);
			})}
		</div>
	);
}
