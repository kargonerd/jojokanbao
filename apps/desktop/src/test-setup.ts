import '@testing-library/jest-dom/vitest';

class MockDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m11 = 1;
  m12 = 0;
  m13 = 0;
  m14 = 0;
  m21 = 0;
  m22 = 1;
  m23 = 0;
  m24 = 0;
  m31 = 0;
  m32 = 0;
  m33 = 1;
  m34 = 0;
  m41 = 0;
  m42 = 0;
  m43 = 0;
  m44 = 1;
  is2D = true;
  isIdentity = true;

  multiplySelf() {
    return this;
  }

  preMultiplySelf() {
    return this;
  }

  translateSelf() {
    return this;
  }

  scaleSelf() {
    return this;
  }

  scale3dSelf() {
    return this;
  }

  rotateSelf() {
    return this;
  }

  rotateFromVectorSelf() {
    return this;
  }

  rotateAxisAngleSelf() {
    return this;
  }

  skewXSelf() {
    return this;
  }

  skewYSelf() {
    return this;
  }

  invertSelf() {
    return this;
  }

  flipX() {
    return this;
  }

  flipY() {
    return this;
  }

  transformPoint(point: DOMPointInit = {}) {
    return {
      x: point.x ?? 0,
      y: point.y ?? 0,
      z: point.z ?? 0,
      w: point.w ?? 1
    };
  }

  toFloat32Array() {
    return new Float32Array(this.toArray());
  }

  toFloat64Array() {
    return new Float64Array(this.toArray());
  }

  toJSON() {
    return this.toArray();
  }

  toString() {
    return 'matrix(1, 0, 0, 1, 0, 0)';
  }

  private toArray() {
    return [this.m11, this.m12, this.m13, this.m14, this.m21, this.m22, this.m23, this.m24, this.m31, this.m32, this.m33, this.m34, this.m41, this.m42, this.m43, this.m44];
  }
}

class MockImageData {
  colorSpace: PredefinedColorSpace = 'srgb';
  data: Uint8ClampedArray;
  height: number;
  width: number;

  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }

    this.data = dataOrWidth;
    this.width = widthOrHeight;
    this.height = height ?? 0;
  }
}

class MockPath2D {
  addPath() {}
  arc() {}
  arcTo() {}
  bezierCurveTo() {}
  closePath() {}
  ellipse() {}
  lineTo() {}
  moveTo() {}
  quadraticCurveTo() {}
  rect() {}
  roundRect() {}
}

if (!('DOMMatrix' in globalThis)) {
  Object.defineProperty(globalThis, 'DOMMatrix', { value: MockDOMMatrix, writable: true });
}

if (!('ImageData' in globalThis)) {
  Object.defineProperty(globalThis, 'ImageData', { value: MockImageData, writable: true });
}

if (!('Path2D' in globalThis)) {
  Object.defineProperty(globalThis, 'Path2D', { value: MockPath2D, writable: true });
}
