# TODO

## 代码重构
- [ ] DocViewer.vue 改为 `<script setup>` + Composition API
- [ ] SearchView.vue 改为 `<script setup>` + Composition API
- [ ] App.vue, MemorialDialog.vue, SupportView.vue 等改为 `<script setup>`

## PDF 功能
- [ ] PdfPage 加 text layer（文字选择/复制）
- [ ] PdfPage 加 annotation layer（PDF 内部链接跳转）
- [ ] 复制时自动删除多余空白字符
- [ ] PDF 内搜索功能
- [ ] PDF 目录/大纲显示

## 性能优化
- [ ] pdfjs-dist 拆分 chunk（当前 index.js 1MB+）
- [ ] cmaps/wasm 改为本地 public 目录托管，去掉 unpkg CDN 依赖
- [ ] 图片资源压缩（首页封面图）

## 构建/部署
- [ ] 生产环境 externals（Vue、Element Plus 走 CDN）
- [ ] GitHub Actions CI（lint + build + Playwright 测试）
- [ ] 去掉 eslint 旧配置（package.json 里的 eslintConfig），改用独立配置文件

## UI
- [ ] 移动端适配优化

## SEO
- [ ] 预渲染静态页面（首页、支持页）
- [ ] 生成 sitemap.xml
- [ ] 从 ES 获取文字版内容，注入到页面 HTML 供爬虫抓取
