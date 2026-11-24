// 鸿蒙部分设备的浏览器内核停留在 Chromium 92 之前，缺少 Array/String.prototype.at。
// 这里只补这一个用到的 API；需要更多时再按同样方式登记，不要整体引入 core-js。
type IndexedLike = { length: number; [index: number]: unknown };

function at(this: IndexedLike, index: number): unknown {
  const length = this.length >>> 0;
  const relative = Math.trunc(index) || 0;
  const resolved = relative < 0 ? length + relative : relative;
  return resolved < 0 || resolved >= length ? undefined : this[resolved];
}

function install(): void {
  const targets = [Array.prototype, String.prototype] as unknown as IndexedLike[];
  for (const target of targets) {
    if (typeof (target as { at?: unknown }).at !== "function") {
      Object.defineProperty(target, "at", { value: at, configurable: true, writable: true });
    }
  }
}

install();
