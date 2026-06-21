declare global {
  interface Uint8Array {
    toHex?: () => string;
  }
}

if (!Uint8Array.prototype.toHex) {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value() {
      let output = '';
      for (const byte of this as Uint8Array) {
        output += byte.toString(16).padStart(2, '0');
      }
      return output;
    },
    configurable: true,
    writable: true
  });
}

export {};
