/**
 * 自动适配的词云渲染函数，直到填满画布
 * @param {HTMLCanvasElement} canvas - canvas 元素
 * @param {Array<[string, number]>} words - 词数组 [['哈哈', 20], ['666', 10]]
 * @param {Object} options - 选项
 */
function renderAutoFitWordCloud(canvas, words, options = {}) {
	const ctx = canvas.getContext("2d");
	const style = getComputedStyle(canvas);
	const cssWidth = parseInt(style.width);
	const cssHeight = parseInt(style.height);
	const ratio = window.devicePixelRatio || 1;

	// 设置高清分辨率
	canvas.width = cssWidth * ratio;
	canvas.height = cssHeight * ratio;
	ctx.scale(ratio, ratio);

	const {
		fontFamily = "sans-serif",
		maxFontSize = 72,
		minFontSize = 12,
		densityTarget = 0.25,
		weightExponent = 0.5,
		rotationSteps = 2,
		rotateRatio = 0.4,
		color = () =>
			["#007CF0", "#00DFD8", "#7928CA", "#FF0080", "#FF4D4D", "#F9CB28"][
				Math.floor(Math.random() * 6)
			],
		backgroundColor = "transparent",
	} = options;

	const weightFactor = createDynamicWeightFactor(words, cssWidth, cssHeight, {
		maxFontSize,
		minFontSize,
		densityTarget,
		weightExponent,
	});

	WordCloud(canvas, {
		list: words,
		gridSize: Math.max(2, Math.floor(cssWidth / 100)), // 自动调整 gridSize
		weightFactor,
		fontFamily,
		color,
		rotateRatio,
		rotationSteps,
		backgroundColor,
		drawOutOfBound: false,
		origin: [cssWidth / 2, cssHeight / 2],
		width: cssWidth,
		height: cssHeight,
	});
}

/* function createDynamicWeightFactor(words, width, height, {
    maxFontSize = 72,
    minFontSize = 12,
    densityTarget = 0.25
} = {}) {
    const weights = words.map(w => w[1]);
    const maxWeight = Math.max(...weights);
    const minWeight = Math.min(...weights);
    const range = maxWeight - minWeight || 1;

    // 移除基于词数的自动缩放
    const realMax = maxFontSize;
    const realMin = minFontSize;

    // 改为基于画布面积的密度控制
    const areaPerWord = (width * height * densityTarget) / words.length;
    const sizeScale = Math.min(1, Math.sqrt(areaPerWord / 500)); // 500是可调基准值

    return function weightFactor(weight) {
        const norm = (weight - minWeight) / range;
        // 应用三次方曲线让大小差异更明显
        const sizeRatio = Math.pow(norm, 0.33); 
        return realMin + (realMax - realMin) * sizeRatio * sizeScale;
    };
} */

function createDynamicWeightFactor(
	words,
	width,
	height,
	{
		maxFontSize = 72,
		minFontSize = 12,
		densityTarget = 0.25,
		weightExponent = 0.5, // 新增权重指数参数
	} = {},
) {
	const weights = words.map((w) => w[1]);
	const maxWeight = Math.max(...weights);
	const minWeight = Math.min(...weights);
	const range = Math.max(1, maxWeight - minWeight); // 确保不为0

	// 计算权重转换曲线
	const weightCurve = (weight) => {
		const normalized = (weight - minWeight) / range;
		// 使用指数曲线放大差异
		return normalized ** weightExponent;
	};

	// 计算动态缩放比例（基于画布面积和词数）
	const areaScale = Math.sqrt((width * height * densityTarget) / words.length) / 20;
	const sizeScale = Math.min(1, Math.max(0.3, areaScale)); // 限制在0.3-1之间

	return (weight) => {
		const curveValue = weightCurve(weight);
		// 应用非线性放大
		return minFontSize + (maxFontSize - minFontSize) * curveValue * sizeScale;
	};
}
