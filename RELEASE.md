# 公开发布流程

浏览器版是主要使用方式，由 Netlify 发布为静态网站。Mac / Windows 桌面版只是
HEIC、TIFF、超出浏览器上限或大批量离线流程的备用方案。

## 发布浏览器版

1. 使用 Node.js 24 运行 `npm ci` 和 `npm test`。
2. 确认 `npm run build` 生成 `dist`，构建产物没有未解析占位符、外部运行时资源、
   分析代码或上传端点。
3. 在 Netlify 的部署预览中检查三种模式、文件限制、下载和页面帮助信息。
4. 将通过检查的提交部署到生产环境。Netlify 读取 `netlify.toml`，运行
   `npm run build` 并发布 `dist`。
5. 发布后确认安全响应头已生效，并再次处理一份中性测试图。不要在测试或截图中使用
   客户图片、真实业务路径、密钥或其他私有信息。

网站是纯静态应用。图片处理发生在浏览器内，不需要 Netlify Functions、上传存储、
分析服务或运行时密钥。

## 用 ExifTool 独立验证输出

浏览器内回读验证通过后，发布者仍应抽样使用独立工具检查显式
`XMP-dc:Subject` 字段。

macOS：

```bash
exiftool -G1 -XMP-dc:Subject processed.jpg
```

Windows：

```powershell
exiftool.exe -G1 -XMP-dc:Subject "processed.jpg"
```

输出应包含 `[XMP-dc] Subject` 和 `contains-synthetic-performer`。macOS Finder 标签、
Windows 文件属性中的“主题”或其他关键词位置都不能替代这项检查。

## 发布桌面备用版

只有 HEIC、TIFF、超出网页 50 MiB / 500 MiB / 300 个文件上限或大批量离线流程，
才引导使用桌面备用版。不要把桌面安装包描述为普通浏览器支持格式的首选入口。

桌面安装包暂未签名。发布前必须完成私有仓库验证，并核对 `release.json` 中三个资产
的文件名、精确字节数和 SHA-256。下载回查 Release 资产时，同时生成并核对
`SHA256SUMS.txt`。

macOS 校验备用安装包：

```bash
shasum -a 256 AI-XMP-Tagger-0.1.0-macOS-arm64.dmg
shasum -a 256 AI-XMP-Tagger-0.1.0-macOS-x64.dmg
```

Windows PowerShell 校验备用安装包：

```powershell
Get-FileHash AI-XMP-Tagger-0.1.0-Windows-x64-Setup.exe -Algorithm SHA256
```

哈希、文件名或大小不匹配时不要运行或发布。不要要求用户关闭 Apple Gatekeeper、
Windows SmartScreen 或降低系统安全设置。Windows 包如果只完成静态架构检查，发布说明
必须明确该验证边界，不能暗示已经在真实 Windows 环境完成安装、启动和卸载测试。

## 独立产品声明

AI XMP Tagger 是独立工具，非 Amazon 官方产品，也未获得 Amazon 的认可或赞助。
