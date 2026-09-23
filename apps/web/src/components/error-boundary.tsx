import { Btn, ErrorNote, Icon } from "@bilibili-notify/ui";
import { Component, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * 渲染期的错误边界。🔴 **没有它,任何一处渲染抛错都会让 React 卸掉整棵树** —— 面板整个白屏,
 * 顶栏也跟着没,主人连「去别的页看看」都做不到。React 只认类组件当边界,所以这里是全仓唯一
 * 一个类组件。
 *
 * 只管**渲染**(以及生命周期、构造)里抛的错:事件处理、异步回调、查询失败都不经过这里 ——
 * 那些各有各的出错态,本来就该在原处说。
 *
 * 两处用它:{@link PageErrorBoundary} 包住路由出口(一页炸了只丢这一页),
 * {@link ExtensionViewBoundary} 包住照拓展声明画的那几块(拓展交来的东西炸了,不连累详情页别的部分)。
 */
interface BoundaryProps {
	children: ReactNode;
	/** 出错时画什么:拿到那个错与一个「清掉、重新画」。 */
	fallback: (error: unknown, reset: () => void) => ReactNode;
	/** 这几样一变就自己清掉(换了一页、换了一个拓展)—— 错误属于原来那一处,不该跟着走。 */
	resetKeys?: readonly unknown[];
}

interface BoundaryState {
	/** 单独一格,不拿 `error` 判:`throw undefined` 也是一次抛错。 */
	failed: boolean;
	error: unknown;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { failed: false, error: undefined };

	static getDerivedStateFromError(error: unknown): BoundaryState {
		return { failed: true, error };
	}

	componentDidUpdate(prev: BoundaryProps, prevState: BoundaryState) {
		/*
		 * 只在「**上一轮就已经是出错态**、这一轮键变了」时清。抛错的那一轮若恰好也换了键(导航那一下
		 * 新页就炸),`prevState.failed` 还是 false —— 这时清掉只会让新页立刻再画一遍、再炸一遍,
		 * 同一个错报两回。
		 */
		if (
			this.state.failed &&
			prevState.failed &&
			keysChanged(prev.resetKeys, this.props.resetKeys)
		) {
			this.reset();
		}
	}

	reset = () => {
		this.setState({ failed: false, error: undefined });
	};

	render() {
		return this.state.failed
			? this.props.fallback(this.state.error, this.reset)
			: this.props.children;
	}
}

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
	return a.length !== b.length || a.some((key, i) => !Object.is(key, b[i]));
}

/**
 * 报错原文。**连错误的种类一起**(`TypeError: …`)—— 渲染期的错十有八九是「读了 undefined 的某一格」,
 * 只剩 message 的话少了一半线索。吞成一句「出错了」等于让人对着黑盒猜。
 */
export function crashText(error: unknown): string {
	if (error instanceof Error) {
		return error.message ? `${error.name}: ${error.message}` : error.name;
	}
	try {
		return typeof error === "object" && error !== null ? JSON.stringify(error) : String(error);
	} catch {
		// 自引用的对象、带 BigInt 的对象 JSON 化会抛 —— 边界自己不能再炸一次。
		return Object.prototype.toString.call(error);
	}
}

/** 原文那一段:等宽、能整段选中复制,长了就折行而不是撑破盒子。 */
function CrashDetail({ error }: { error: unknown }) {
	return (
		<code className="mt-1 block whitespace-pre-wrap break-all font-mono text-bn-xs opacity-90">
			{crashText(error)}
		</code>
	);
}

/**
 * 包住路由出口:一页渲染炸了,**只丢这一页** —— 顶栏、角落里的通知与女仆胶囊都还在,还能点去别的页。
 *
 * 换一页就自己清掉(键是路径):错误属于那一页。状态提示,口吻照旧中性。
 */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
	const { pathname } = useLocation();
	return (
		<ErrorBoundary
			resetKeys={[pathname]}
			fallback={(error, reset) => <PageCrashNote error={error} onRetry={reset} />}
		>
			{children}
		</ErrorBoundary>
	);
}

function PageCrashNote({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	return (
		<div className="bn-anim-page-in flex flex-col gap-3">
			<ErrorNote icon={<Icon.warning size={15} />}>
				<strong className="font-bold">这一页没能画出来。</strong>
				顶栏和别的页不受影响;可以重试一次,或者先去别的页。
				<CrashDetail error={error} />
			</ErrorNote>
			<div className="flex gap-2">
				<Btn variant="primary" size="sm" onClick={onRetry}>
					重试
				</Btn>
				{/* 首页自己炸了就不给:那一下和重试是同一件事,两颗钮只会让人以为有区别。 */}
				{pathname === "/" ? null : (
					/*
					 * 只导航、**不顺手 reset**:路径一变边界自己会清。🔴 两样一起做的话,reset 是同步那一档、
					 * 先于导航(路由的导航走 transition)单独画一遍 —— 画的还是旧路径上那一页,白白再炸
					 * 一次,React 还会把它当成「并发渲染里出错、同步重画救回来了」报一条错。
					 */
					<Btn variant="outline" size="sm" onClick={() => navigate("/")}>
						回首页
					</Btn>
				)}
			</div>
		</div>
	);
}

/**
 * 包住照拓展声明画的那几块(头卡里的页级积木、「配置」页签)。那是**拓展交来的**视图 —— 面板比
 * 服务端旧的那几秒(应用内升级)、或者渲染器自己的漏洞,都可能让它在画的时候抛错;炸了只换掉
 * 这一块,头卡的名字、开关、删除钮与页上别的部分照常。
 *
 * 换一个拓展(`resetKey` 是它的 id)就自己清。
 */
export function ExtensionViewBoundary({
	resetKey,
	children,
}: {
	resetKey: string;
	children: ReactNode;
}) {
	return (
		<ErrorBoundary
			resetKeys={[resetKey]}
			fallback={(error, reset) => (
				<ErrorNote size="sm" icon={<Icon.warning size={13} />}>
					<div className="flex flex-wrap items-start gap-2">
						<div className="min-w-0 flex-1">
							这个拓展交来的这一块没能画出来。
							<CrashDetail error={error} />
						</div>
						<Btn variant="outline" size="sm" onClick={reset}>
							重试
						</Btn>
					</div>
				</ErrorNote>
			)}
		>
			{children}
		</ErrorBoundary>
	);
}
