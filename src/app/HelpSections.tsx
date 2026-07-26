export function HelpSections() {
  return (
    <section id="instructions" class="help-section" aria-labelledby="help-title">
      <h2 id="help-title">3. 使用说明</h2>
      <div class="help-grid">
        <article>
          <h3>三种模式怎么选</h3>
          <ul>
            <li><strong>转为高清 JPG：</strong>JPG 直接写入；PNG、BMP、静态 WebP 转为高质量 JPG。动态 WebP 会拒绝，请切换保持原格式。</li>
            <li><strong>保持原格式：</strong>JPG、PNG、静态或动态 WebP 保持原格式写入；BMP 不支持。</li>
            <li><strong>只检查：</strong>不改图片，只检查 JPG、PNG、静态或动态 WebP 的标签并生成 CSV；BMP 不支持。</li>
          </ul>
        </article>
        <article>
          <h3>格式与处理上限</h3>
          <ul>
            <li>输入：JPG、JPEG、PNG、WebP、BMP。</li>
            <li>输出：默认模式为 JPG；保持原格式模式为 JPG、PNG 或 WebP。</li>
            <li>单个文件 ≤ 50 MiB；批次 ≤ 300 个且合计 ≤ 500 MiB。</li>
            <li>需要转换的图片最大 40 MP（4,000 万像素）。</li>
            <li>超过 100 个或 250 MiB 会提醒，但仍可继续。</li>
          </ul>
        </article>
        <article id="privacy">
          <h3>本地处理与隐私</h3>
          <ul>
            <li>所有图片只在当前浏览器内处理，不会上传服务器。</li>
            <li>Netlify 只会收到普通页面请求和静态资源请求；不会收到你选择的图片、文件名或处理结果。</li>
            <li>本站不存储图片，也不接入统计、外部字体或第三方脚本。</li>
            <li>转为 JPG 时会移除 EXIF、GPS 等元数据，只保留原有 XMP dc:subject 关键词并加入目标标签。</li>
            <li>关闭页面前，请先下载需要保留的处理结果。</li>
          </ul>
        </article>
      </div>
      <div class="verification-help">
        <h3>浏览器与桌面备用方案</h3>
        <p>
          建议使用最新版 Chrome、Edge 或 Safari。浏览器版是普通 JPG、PNG、
          WebP 和 BMP 的首选；HEIC、TIFF、超出网页上限或大批量离线流程，
          可使用 Mac / Windows 桌面版作为备用。
        </p>
      </div>
      <div class="verification-help">
        <h3>标签写在哪里，怎么检查？</h3>
        <p>
          写入位置是 <code>XMP dc:subject rdf:Bag</code>，关键词必须精确为
          {" "}<code>contains-synthetic-performer</code>。处理后可先看本站 CSV；
          也可在 macOS“预览”的关键词检查器、Windows 支持 XMP 的工具，或
          ExifTool 中查看显式的 <code>XMP-dc:Subject</code> 字段。
        </p>
      </div>
    </section>
  );
}
