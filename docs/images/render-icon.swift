// 图标总生成器 —— 一次产出 README 的 LOGO 与桌面端三平台资产。
//
//   swift render-icon.swift
//
// 在本目录(docs/images/)下跑,只要 Command Line Tools。产出:
//   logo-squircle.png                              README 用,512 × 512
//   ../../apps/desktop/src-tauri/icons/icon.icns   macOS —— 10 个切片
//   ../../apps/desktop/src-tauri/icons/icon.ico    Windows —— 6 个切片,PNG 编码
//   ../../apps/desktop/src-tauri/icons/32x32.png   Linux / 通用
//   ../../apps/desktop/src-tauri/icons/64x64.png
//   ../../apps/desktop/src-tauri/icons/128x128.png
//   ../../apps/desktop/src-tauri/icons/128x128@2x.png
//
// 两端一起出是**故意的**:它们必须是同一张母图的不同尺寸。上一代是 README 与桌面端
// 各一个脚本、参数各写一份,得记着两个都跑 —— 漏一个就是「README 一个样、桌面端
// 另一个样」,而这种不一致没人会立刻发现。那两个脚本已随本脚本落地删除。
//
// ## 只有一个源文件:logo.png
//
// 上一代脚本把整张 `logo.png` 缩进 squircle,图形和背景是烘死的,没有「偏移」这个
// 概念 —— 那就是为什么它做不到下面的质心居中。这里先把两者**拆开**再重新合成。
//
// 拆得开是因为这张图的构成特别干净:蓝底 `#00AEEE` 的 **R 通道是 0**,白色图形的
// R 是 255 —— **R 通道本身就是一张现成的 alpha 遮罩**,过渡带只占 0.24% 的像素。
// 底色的 R 带 0~5 噪声,所以加一道 levels 校正(lo=16 / hi=240)再当遮罩用。
//
// 验证过:这样抠出来的前景与 Icon Composer 里那张手工抠的 `foreground.png`
// **逐项一致** —— 质心 (513.82, 499.60) 两者小数点后两位相同,包围盒 617×585、
// 上留白 169、不透明总量 139014 全部吻合。所以不必额外存一份前景图。
//
// ## 质心居中:算出来的,不是填进去的
//
// 这个 logo 的图形**偏上**:包围盒上留白 170、下留白 270。但要居中的不是包围盒。
// 当初做连通分量分析,把四种锚点都量了一遍(位置自顶算,画布中心 512):
//
//   整体包围盒(含细天线)   +51     461.5   ← 试过,主人否掉:整体被压得偏下
//   整体质心               +12     499.7   ← 采用
//   铃铛主体               +13     499.0
//   铃铛完整(含底部小锤)   −11.5   523.5   ← 铃铛在框内本就靠下,按它居中会顶得偏上
//
// **整体质心与铃铛主体中心几乎重合(499.7 / 499.0)** —— 两个完全独立的算法落在同一点,
// 那就是光学中心:细天线权重低、被质心自动折价,而铃铛作为视觉主体恰好坐在那儿。
// 所以用质心同时满足「以铃铛为基准」和「整体视觉平衡」,不是随手挑的。
//
// 脚本每次现算,不硬编码位移量 —— 换 logo 时自动跟着变,也不必关心哪个工具的 y 轴朝哪边。
//
// (Icon Composer 里手调出来的那个 `translation-in-points: [0, 13.44]` 就是这个数:
//  12.6 × 1.12 = 14.1,手调停在了 13.44。)
//
// ⚠️ 坐标系:位图 buffer 的**行 0 是顶部**,而 CGContext 的 **y 轴向上**。这里判反过
//    一次,居中越修越偏。下面 `cyUp` 那行的翻转别动。
//
// ## 尺寸与形状(都是实测,别凭印象改)
//
// - **图形放大 `1.12`** —— 主人在 Icon Composer 里定的。这个 logo 的电视外框是细描边,
//   填充率只有 16%(实心块类的 App 图标是 46~47%),不放大会显得「背景很大、图形很小」。
//   1.12 把它提到 20%,追平同为描边风格的 WhatsApp / Apple Music。再往上就得加粗描边、
//   改矢量设计了(位图膨胀试过:会把铃铛一起吹胖、吃掉空隙,不通)。
// - **主体占画布 `824/1024` = 80.5%** —— macOS 26.6 上实测五个系统 App(Mail / Music /
//   Notes / Safari / 系统设置),主体包围盒**一律 80.5%**,一个不差,正是 HIG 那个数。
//   满幅的话 Dock 里会比左右邻居大 `1/0.805 ≈ 24%`,肉眼极明显。
// - **投影烘在资产里**,不是 Dock 加的。按 alpha 阈值扫 Safari:α>40 停在 80.5%
//   (主体硬边),α>10 到 83.6%,α>1 到 86.7%(投影外沿)。`blur` 照这个扫出来:
//   20 → 82.0/84.4(太紧)、**32 → 83.6/85.9**(命中)、38 → 84.4/87.5(反向超出同样多)。
//   上一代脚本用的 20 偏紧,这里改成 32。
// - 圆角走 SwiftUI 的 `.continuous` —— 苹果自己的 squircle,角部曲率渐变,与普通圆角
//   矩形(`.circular`)肉眼可辨。不要用近似路径替换它。
//
// ## 图标不进任何构建流程
//
// 没有一个构建步骤会生成它们。`tauri.conf.json` 的 `bundle.icon` 直接引用仓库里
// 已提交的那几个文件,打包时只是读。
//
// ⚠️ 所以**产物必须留在仓库里** —— 顺手把 `apps/desktop/src-tauri/icons/` ignore 掉的话,
//    桌面端打包当场断。两个源文件同理:它们入库,换 logo 才不依赖某一个人的机器。
import AppKit
import SwiftUI

let canvas: CGFloat = 1024
/// 主体占画布的比例。824/1024 = 80.47%,与实测的系统 App 一致。
let body: CGFloat = 824
let radius: CGFloat = 185.4
/// 图形相对「填满画布」的放大倍数。
let foregroundScale: CGFloat = 1.12
let shadowOffset: CGFloat = 10
let shadowBlur: CGFloat = 32
let shadowAlpha: CGFloat = 0.25

let source = "logo.png"
let readmeTarget = "logo-squircle.png"
/// 从 R 通道抠前景时的 levels 校正:底色的 R 有 0~5 噪声,纯白那头也不到 255。
let maskBlack: Double = 16
let maskWhite: Double = 240
/// README 里显示宽度 200px,Retina 2x 也才 400,512 绰绰有余;1024 只会让图白白大一倍。
let readmeSize = 512
let desktopDir = "../../apps/desktop/src-tauri/icons"

/// iconutil 认的十个切片:文件名 → 像素边长。
let icnsSlices: [(name: String, px: Int)] = [
	("icon_16x16", 16),
	("icon_16x16@2x", 32),
	("icon_32x32", 32),
	("icon_32x32@2x", 64),
	("icon_128x128", 128),
	("icon_128x128@2x", 256),
	("icon_256x256", 256),
	("icon_256x256@2x", 512),
	("icon_512x512", 512),
	("icon_512x512@2x", 1024),
]
/// 与历史 icon.ico 相同的尺寸构成,别擅自增删 —— Windows 各处(任务栏 / 资源管理器 /
/// Alt-Tab)按尺寸挑切片,少一档就得由系统现缩,糊。
let icoSlices = [16, 24, 32, 48, 64, 256]
/// tauri.conf.json 的 bundle.icon 直接引用的那几个,外加目录里同源的 64x64。
let looseSlices: [(file: String, px: Int)] = [
	("32x32.png", 32),
	("64x64.png", 64),
	("128x128.png", 128),
	("128x128@2x.png", 256),
]

func fail(_ msg: String) -> Never {
	FileHandle.standardError.write("render-icon: \(msg)\n".data(using: .utf8)!)
	exit(1)
}

func load(_ path: String) -> CGImage {
	guard let img = NSImage(contentsOfFile: path),
		let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
	else { fail("读不出 \(path) —— 请在 docs/images/ 目录下运行") }
	guard cg.width == Int(canvas), cg.height == Int(canvas) else {
		fail("\(path) 应为 \(Int(canvas))×\(Int(canvas)),实际 \(cg.width)×\(cg.height)")
	}
	return cg
}

/// 解成 sRGB 8bit 缓冲。**行 0 是顶部。**
func pixels(_ img: CGImage) -> [UInt8] {
	let w = img.width, h = img.height
	var buf = [UInt8](repeating: 0, count: w * h * 4)
	guard
		let ctx = CGContext(
			data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
			space: CGColorSpace(name: CGColorSpace.sRGB)!,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		)
	else { fail("建不出取样画布") }
	ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
	return buf
}

let sourceImage = load(source)
let sourcePixels = pixels(sourceImage)

// ---- 底色:四角取中位数 ------------------------------------------------------
// 直接采一个点不行 —— 这张图的蓝底带 ±2 的噪声(非白区域有 5000+ 种颜色)。
let backdropColor: NSColor = {
	let w = sourceImage.width, h = sourceImage.height
	let margin = 24
	var rs: [Int] = [], gs: [Int] = [], bs: [Int] = []
	for (x, y) in [(margin, margin), (w - margin, margin), (margin, h - margin), (w - margin, h - margin)] {
		let i = (y * w + x) * 4
		rs.append(Int(sourcePixels[i])); gs.append(Int(sourcePixels[i + 1])); bs.append(Int(sourcePixels[i + 2]))
	}
	func median(_ v: [Int]) -> CGFloat { CGFloat(v.sorted()[v.count / 2]) / 255 }
	return NSColor(srgbRed: median(rs), green: median(gs), blue: median(bs), alpha: 1)
}()

// ---- 前景:拿 R 通道当遮罩抠出来 ---------------------------------------------
// 理由见文件头。输出是 premultiplied 的白色 + alpha,可直接当图层画。
let foreground: CGImage = {
	let w = sourceImage.width, h = sourceImage.height
	var buf = [UInt8](repeating: 0, count: w * h * 4)
	for i in stride(from: 0, to: sourcePixels.count, by: 4) {
		let a = max(0, min(1, (Double(sourcePixels[i]) - maskBlack) / (maskWhite - maskBlack)))
		let v = UInt8(a * 255)
		buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = v
	}
	guard
		let ctx = CGContext(
			data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
			space: CGColorSpace(name: CGColorSpace.sRGB)!,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		), let out = ctx.makeImage()
	else { fail("抠前景失败") }
	return out
}()

// ---- 前景质心 ---------------------------------------------------------------
// 按不透明度加权,而不是取包围盒中心 —— 理由见文件头。
let (centroidX, centroidYUp): (CGFloat, CGFloat) = {
	let w = foreground.width, h = foreground.height
	let buf = pixels(foreground)
	var sx = 0.0, sy = 0.0, total = 0.0
	for y in 0..<h {
		for x in 0..<w {
			let a = Double(buf[(y * w + x) * 4 + 3])
			guard a > 0 else { continue }
			sx += Double(x) * a; sy += Double(y) * a; total += a
		}
	}
	// 抠出来全透明 = 遮罩没命中任何东西,多半是换了非蓝底的 logo,levels 参数要重调。
	guard total > 0 else { fail("从 \(source) 抠出的前景整张全透明 —— 底色不是蓝的?") }
	let cx = sx / total, cyDown = sy / total
	// buffer 行 0 在顶部,CGContext 的 y 向上 —— 这里翻转。判反过一次,别动。
	let cyUp = Double(h) - cyDown
	print(String(format: "前景质心 x=%.1f y=%.1f(自顶部)  偏上 %.1f px", cx, cyDown, Double(h) / 2 - cyDown))
	return (CGFloat(cx), CGFloat(cyUp))
}()

// ---- 合成母图:底色 + 放大并居中的图形 ---------------------------------------
let master: CGImage = {
	guard
		let ctx = CGContext(
			data: nil, width: Int(canvas), height: Int(canvas), bitsPerComponent: 8, bytesPerRow: 0,
			space: CGColorSpace(name: CGColorSpace.sRGB)!,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		)
	else { fail("建不出母图画布") }
	ctx.interpolationQuality = .high
	ctx.setFillColor(backdropColor.cgColor)
	ctx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))

	// 放大后把质心摆到画布正中:origin = 中心 - 质心 × 倍数。
	let side = canvas * foregroundScale
	let origin = CGPoint(
		x: canvas / 2 - centroidX * foregroundScale,
		y: canvas / 2 - centroidYUp * foregroundScale
	)
	ctx.draw(foreground, in: CGRect(x: origin.x, y: origin.y, width: side, height: side))
	guard let out = ctx.makeImage() else { fail("母图合成失败") }
	return out
}()

/// 把母图缩到 `side` 见方的画布里:主体占 80.5% 居中,套 squircle,烘一道投影。
func render(side: Int) -> CGImage {
	let s = CGFloat(side)
	let scale = s / canvas
	guard
		let ctx = CGContext(
			data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
			space: CGColorSpace(name: CGColorSpace.sRGB)!,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		)
	else { fail("建不出 \(side)px 画布") }

	let inset = (canvas - body) / 2 * scale
	let rect = CGRect(x: inset, y: inset, width: body * scale, height: body * scale)
	let path = RoundedRectangle(cornerRadius: radius * scale, style: .continuous).path(in: rect).cgPath

	// ① 投影层:先拿实心 squircle 投一道影。必须在 clip 之前 —— 裁剪之后画的话
	//    影子会连同外溢部分一起被裁没。填充色随便,② 会整块盖住。
	ctx.saveGState()
	ctx.setShadow(
		offset: CGSize(width: 0, height: -shadowOffset * scale),
		blur: shadowBlur * scale,
		color: NSColor.black.withAlphaComponent(shadowAlpha).cgColor
	)
	ctx.addPath(path)
	ctx.setFillColor(NSColor.black.cgColor)
	ctx.fillPath()
	ctx.restoreGState()

	// ② 图像层。
	ctx.saveGState()
	ctx.addPath(path)
	ctx.clip()
	ctx.interpolationQuality = .high
	ctx.draw(master, in: rect)
	ctx.restoreGState()

	guard let out = ctx.makeImage() else { fail("\(side)px 渲染失败") }
	return out
}

func png(_ image: CGImage) -> Data {
	guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
	else { fail("PNG 编码失败") }
	return data
}

let fm = FileManager.default
guard fm.fileExists(atPath: desktopDir) else { fail("找不到 \(desktopDir)") }

// ---- README ---------------------------------------------------------------
try png(render(side: readmeSize)).write(to: URL(fileURLWithPath: readmeTarget))
print("\(readmeTarget)  \(readmeSize)×\(readmeSize)")

// ---- macOS ----------------------------------------------------------------
let work = fm.temporaryDirectory.appendingPathComponent("render-icon-\(getpid()).iconset")
try fm.createDirectory(at: work, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: work) }

for slice in icnsSlices {
	try png(render(side: slice.px)).write(to: work.appendingPathComponent("\(slice.name).png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", work.path, "-o", "\(desktopDir)/icon.icns"]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fail("iconutil 退出码 \(iconutil.terminationStatus)") }
print("icon.icns        \(icnsSlices.count) 个切片")

// ---- Windows --------------------------------------------------------------
// ICO 是手写的:macOS 没有 ico 编码器,而格式本身很薄 —— 一个 6 字节的 ICONDIR、
// 每片 16 字节的 ICONDIRENTRY,后面直接跟 PNG 数据(Vista 起支持 PNG 内嵌)。
// 全部小端序;边长 256 在那一个字节里写 0(255 是上限,0 约定为 256)。
func encodeICO(_ sides: [Int]) -> Data {
	let images = sides.map { png(render(side: $0)) }
	var out = Data()
	out.append(contentsOf: [0, 0])  // reserved
	out.append(contentsOf: [1, 0])  // type 1 = icon
	out.append(contentsOf: [UInt8(sides.count & 0xFF), UInt8(sides.count >> 8)])

	var offset = 6 + 16 * sides.count
	for (i, side) in sides.enumerated() {
		let byte = side >= 256 ? 0 : side
		out.append(contentsOf: [UInt8(byte), UInt8(byte)])  // width, height
		out.append(contentsOf: [0, 0])  // palette count, reserved
		out.append(contentsOf: [1, 0])  // color planes
		out.append(contentsOf: [32, 0])  // bits per pixel
		var size = UInt32(images[i].count).littleEndian
		var off = UInt32(offset).littleEndian
		withUnsafeBytes(of: &size) { out.append(contentsOf: $0) }
		withUnsafeBytes(of: &off) { out.append(contentsOf: $0) }
		offset += images[i].count
	}
	for image in images { out.append(image) }
	return out
}
try encodeICO(icoSlices).write(to: URL(fileURLWithPath: "\(desktopDir)/icon.ico"))
print("icon.ico         \(icoSlices.count) 个切片 \(icoSlices.map(String.init).joined(separator: "/"))")

// ---- Linux / 通用 ----------------------------------------------------------
for slice in looseSlices {
	try png(render(side: slice.px)).write(to: URL(fileURLWithPath: "\(desktopDir)/\(slice.file)"))
	print("\(slice.file.padding(toLength: 17, withPad: " ", startingAt: 0))\(slice.px)px")
}
