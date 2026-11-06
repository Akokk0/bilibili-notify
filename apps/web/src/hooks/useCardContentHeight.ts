import { useLayoutEffect, useRef } from "react";

/** 读玻璃卡的自然高度，排除可展开内容；外部最小高度不参与计算，避免互相撑高。 */
export function useCardContentHeight(
	onHeight: ((height: number) => void) | undefined,
	expansionSelector?: string,
) {
	const content = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const node = content.current;
		const card = node?.closest<HTMLElement>(".bn-glass");
		if (!node || !card || !onHeight) return;
		const measure = () => {
			let bottom = 0;
			for (
				let parent = node.parentElement;
				parent && card.contains(parent);
				parent = parent.parentElement
			) {
				const style = getComputedStyle(parent);
				bottom +=
					Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth);
			}
			const rect = node.getBoundingClientRect();
			const expanded = expansionSelector
				? Array.from(node.querySelectorAll<HTMLElement>(expansionSelector)).reduce(
						(sum, element) => sum + element.getBoundingClientRect().height,
						0,
					)
				: 0;
			const height = Math.ceil(
				rect.top - card.getBoundingClientRect().top + rect.height + bottom - expanded,
			);
			if (height > 0) onHeight(height);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		observer.observe(card);
		if (node.parentElement) observer.observe(node.parentElement);
		return () => observer.disconnect();
	}, [onHeight, expansionSelector]);
	return content;
}
