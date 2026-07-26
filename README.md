# AI XMP Tagger

AI XMP Tagger 是一个可以直接在浏览器里批量写入或检查
`contains-synthetic-performer` 的工具。无需安装软件：选择图片、选择模式、开始处理，
再下载处理结果或 CSV 报告。

图片只在当前浏览器中处理，不会上传服务器。网站不存储图片或路径，也不接入统计、
远程字体或第三方运行时脚本。关闭或刷新页面后，尚未下载的结果无法恢复。

## 三种处理模式

| 模式 | JPG / JPEG | PNG | 静态 WebP | 动态 WebP | BMP |
| --- | --- | --- | --- | --- | --- |
| 转为高清 JPG 并写入标签 | 保持 JPEG 图像数据，直接写入 XMP | 转为高质量 JPG | 转为高质量 JPG | 不支持转换 | 转为高质量 JPG |
| 保持原格式并写入标签 | 保持 JPG | 保持 PNG | 保持 WebP | 保持动态 WebP | 不支持 |
| 只检查标签 | 检查，不修改 | 检查，不修改 | 检查，不修改 | 检查，不修改 | 不支持 |

“转为高清 JPG”会把透明区域合成白色背景，以质量 100、4:4:4 色度采样和嵌入
sRGB ICC 配置文件的方式编码。转换后的文件只保留原有 `XMP dc:subject` 关键词并加入
目标标签；其他 EXIF、GPS 和容器元数据会被移除。保持原格式模式不会重编码图像像素。

本站不会判断图片是不是 AI 生成，也不会替卖家判断是否需要披露。请只对确实包含
AI 生成人物的适用媒体写入标签。

## 格式、上限与浏览器

- 支持输入 JPG/JPEG、PNG、WebP 和 BMP。
- 一次最多 300 个文件。
- 单个文件最大 50 MiB，整个批次最大 500 MiB。
- 需要转换的图片最大 40 MP（4,000 万像素）。
- 建议使用最新版 Chrome、Edge 或 Safari，并在 64 位桌面系统中处理。

浏览器版是主要使用方式。HEIC、TIFF、超出上述限制的文件或大批量离线流程，可使用
Mac / Windows 桌面版作为备用方案；普通 JPG、PNG、WebP 和 BMP 不需要下载桌面版。

## 独立检查 XMP

网页会在每个文件写入后重新读取并验证标签。需要用独立工具复核时，可以安装
[ExifTool](https://exiftool.org/) 并明确读取 `XMP-dc:Subject`。

macOS 终端：

```bash
exiftool -G1 -XMP-dc:Subject processed.jpg
```

Windows PowerShell 或命令提示符：

```powershell
exiftool.exe -G1 -XMP-dc:Subject "processed.jpg"
```

正确结果应在 `[XMP-dc] Subject` 中显示
`contains-synthetic-performer`。Finder 的“标签”和 Windows 文件属性中的其他字段
不等同于显式的 `XMP dc:subject`，因此不应作为唯一验证依据。

## 本地开发与 Netlify

需要 Node.js 24。安装锁定依赖并启动开发服务器：

```bash
npm ci
npm run dev
```

构建和本地预览 Netlify 将发布的静态文件：

```bash
npm run build
npm run preview
```

提交前运行完整验证：

```bash
npm test
```

Netlify 会读取仓库根目录的 `netlify.toml`，运行 `npm run build` 并发布 `dist`。
可在 Netlify 控制台连接本仓库进行预览部署或生产部署；不需要服务器函数、上传端点或
运行时环境变量。

## 桌面备用版发布信息

`release.json` 仅保留 Mac / Windows 桌面备用版的版本、文件大小和 SHA-256 信息，
用于 HEIC、TIFF、超出浏览器限制或大批量离线流程。桌面包的发布和校验说明见
[`RELEASE.md`](./RELEASE.md)。

## 独立产品声明

AI XMP Tagger 是独立工具，非 Amazon 官方产品，也未获得 Amazon 的认可或赞助。
Amazon 及相关名称和标志是其各自权利人的商标。
