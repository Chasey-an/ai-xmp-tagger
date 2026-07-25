# 公开发布流程

本流程用于 AI XMP Tagger 公开测试版。安装包暂未签名；发布者必须先完成私有仓库验证，再公开 Release 和网站。

## 安全说明

- 下载后先核对 GitHub Release 来源，并使用 `SHA256SUMS.txt` 验证 SHA-256，再运行安装包。
- macOS 出现 Apple Gatekeeper 提示时，确认来源和 SHA-256 无误后，通过 Finder 对安装包使用“打开”，并按系统提供的单次确认流程继续。
- Windows 出现 Windows SmartScreen 提示时，只有在来源、文件名和 SHA-256 均匹配时，才通过系统的“更多信息”查看发布者与文件信息并决定是否继续。
- 不要关闭或停用 Apple Gatekeeper 或 Windows SmartScreen，也不要要求用户降低系统安全设置。

## Windows 验证边界

Windows 包只完成静态架构和资源验证。当前版本尚未在真实 Windows 设备或虚拟机中完成安装、启动和卸载验证；发布说明和网站不得暗示已完成这些测试。

## 发布顺序

1. 在私有仓库运行全部测试与 `npm test`、类型检查（typecheck）、三个平台安装包打包，并在 macOS 完成 Mac 安装、启动和基本功能冒烟（smoke）测试。
2. 对照发布清单核对三个安装包的文件名、精确字节数（bytes）和 SHA-256 哈希，并生成 `SHA256SUMS.txt`。
3. 创建 GitHub 预发布（pre-release），上传 3 个安装包和 `SHA256SUMS.txt`；下载回查这些资产，确认大小与哈希未变化。
4. 发布 GitHub Release；确认 Release 及其下载链接公开可用后，再手动运行 `Test and deploy GitHub Pages` 工作流发布 GitHub Pages。
5. 检查公开页面、下载链接与全部 Release 资产（assets），确认只包含预期文件，且没有私有源码、桌面应用源码、客户素材、密钥或本机路径。

在第 4 步完成前，不要发布 Pages，也不要为 Pages 工作流添加 `push` 触发器。
