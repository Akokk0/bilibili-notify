/**
 * 「这个字段的默认值有更新」的广播通道。
 *
 * 主人改了某条模板的默认文案,已装好的用户拿不到 —— 他们盘上写的是当初那一版。
 * 提示得逐字段落在那条文案旁边,可模板字段有十几个、散在五个 section 里,逐个
 * 接线既啰嗦又漏得掉。
 *
 * 所以走 context:`Field` 本来就带着全局唯一的 `code`(`templates.liveStart`
 * 这种),让它自己拿 code 来问一句「我有更新吗」。于是那十几个调用点**一个都
 * 不用改**,将来加新模板字段也自动带上提示。
 *
 * 没有 Provider 时 `useFieldUpdate` 恒返回 null —— `Field` 在别处(过滤、日程)
 * 照常是那个通用组件,不背模板的包袱。
 */

import { createContext, useContext } from "react";

export interface FieldUpdate {
	/** 新默认的文案,摆给用户看清楚「要换成什么」。 */
	preview: string;
	/** 换成新默认。 */
	accept: () => void;
	/** 留着自己的,只把这一版记进账本(下次不再问)。 */
	keep: () => void;
}

export interface FieldUpdates {
	/** 给定字段 code,回答它有没有待处理的默认更新。 */
	lookup: (code: string) => FieldUpdate | null;
	/**
	 * 给定字段 code,回答「能不能还原成默认」以及怎么还原;值本来就是默认时返回 null。
	 *
	 * 跟 {@link lookup} 是两件事:那个管「默认变了要不要跟」(有条件出现、处理完就
	 * 消失),这个管「我改坏了想还原」(只要值不是默认就一直在)。
	 */
	resetter: (code: string) => (() => void) | null;
}

const FieldUpdatesContext = createContext<FieldUpdates | null>(null);

export const FieldUpdatesProvider = FieldUpdatesContext.Provider;

export function useFieldUpdate(code: string): FieldUpdate | null {
	const ctx = useContext(FieldUpdatesContext);
	return ctx ? ctx.lookup(code) : null;
}

export function useFieldReset(code: string): (() => void) | null {
	const ctx = useContext(FieldUpdatesContext);
	return ctx ? ctx.resetter(code) : null;
}
