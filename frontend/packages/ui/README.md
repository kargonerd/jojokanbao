# @jojo/ui

共享 React 组件与 CSS 设计系统。

## 组件

| 组件 | 用途 |
|------|------|
| `Button` | 按钮（primary / outline / text） |
| `Card` | 卡片容器（带 hover 硬阴影效果） |
| `Tag` | 标签 |
| `NavBar` | 导航栏（桌面下拉 + 移动端汉堡菜单） |
| `Modal` | 模态弹窗 |
| `Pagination` | 分页器 |
| `LoadingSpinner` | 加载指示器 |

## 使用

```tsx
import { Button, Card, Tag } from "@jojo/ui";

<Button variant="outline" onClick={handleClick}>点击</Button>
<Card className="p-4">内容</Card>
<Tag>标签</Tag>
```

应用入口同时加载统一样式：

```css
@import "@jojo/ui/styles";
```

## 测试

```bash
pnpm --filter @jojo/ui test
```
