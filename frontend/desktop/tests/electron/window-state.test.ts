import { describe, expect, it } from 'vitest';

import {
  getDefaultWindowBounds,
  getRestorableWindowBounds,
} from '../../electron/window-state.js';

const workArea = { x: 0, y: 0, width: 1465, height: 869 };

describe('desktop window state', () => {
  it('centers a normal window with room to see that it is restored', () => {
    const bounds = getDefaultWindowBounds(workArea);

    expect(bounds.width).toBeLessThan(workArea.width);
    expect(bounds.height).toBeLessThan(workArea.height);
    expect(bounds.x).toBeGreaterThan(0);
    expect(bounds.y).toBeGreaterThan(0);
  });

  it('repairs legacy maximized states whose normal bounds filled the work area', () => {
    expect(getRestorableWindowBounds(workArea, workArea, true)).toEqual(
      getDefaultWindowBounds(workArea),
    );
  });

  it('preserves an intentional normal-size restore target', () => {
    const bounds = { x: 80, y: 40, width: 1280, height: 780 };

    expect(getRestorableWindowBounds(bounds, workArea, true)).toEqual(bounds);
    expect(getRestorableWindowBounds(workArea, workArea, false)).toEqual(workArea);
  });
});
