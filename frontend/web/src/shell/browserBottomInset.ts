// 部分鸿蒙浏览器把底部工具栏叠在网页之上：网页视口仍按整屏计算，底部固定元素被工具栏盖住，
// 且 env(safe-area-inset-bottom) 为 0。这里用 visualViewport 与窗口高度的差值把工具栏高度量出来，
// 写进 --app-browser-inset-bottom 供底部导航让位。键盘弹起时差值远大于工具栏高度，按工具栏处理会把
// 导航顶到键盘上方，所以超出上限一律视为键盘并忽略。
const MAX_BROWSER_TOOLBAR_INSET = 160;

export function syncBrowserBottomInset(): () => void {
  const visual = window.visualViewport;
  if (!visual) return () => {};
  const root = document.documentElement;
  const update = () => {
    const inset = Math.round(window.innerHeight - visual.offsetTop - visual.height);
    const applied = inset > 0 && inset <= MAX_BROWSER_TOOLBAR_INSET ? inset : 0;
    root.style.setProperty("--app-browser-inset-bottom", `${applied}px`);
  };
  update();
  visual.addEventListener("resize", update);
  visual.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  return () => {
    visual.removeEventListener("resize", update);
    visual.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    root.style.removeProperty("--app-browser-inset-bottom");
  };
}
