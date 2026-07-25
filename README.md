# AI XMP Tagger

这是 AI XMP Tagger 公开测试版（public beta）的网站与下载仓库。网站通过 GitHub Pages 发布，Mac 与 Windows 安装包通过 GitHub Releases 提供。

本仓库只包含公开网站、经过筛选的展示素材和发布校验信息。桌面应用源码不在本仓库。

## 隐私边界

网站是静态页面，不会接收图片、路径或用户数据，也不包含分析或跟踪代码。桌面应用对图片的处理在用户本机完成。

## 本地预览与验证

已安装 Node.js 24 时，可使用锁定的依赖版本启动本地预览：

```bash
npm ci
npm run dev
```

如果没有可用的锁文件，也可以安装依赖后预览：

```bash
npm install
npm run dev
```

提交前运行完整验证：

```bash
npm test
```

## 截图来源

网站截图仅使用经过清理的中性测试素材，不包含客户图片、真实业务路径或其他私有信息。如果某张截图将应用界面的 Preview 区域替换为 ExifTool 输出的捕获画面，会在截图说明中如实标注，不把替代画面描述成应用原生预览。

## 独立产品声明

AI XMP Tagger 是独立工具，非 Amazon 官方产品，也未获得 Amazon 的认可或赞助。Amazon 及相关名称和标志是其各自权利人的商标。
