import '@testing-library/jest-dom/vitest';

// jsdom has no PointerEvent: provide one so pointer coordinates/type reach handlers in tests.
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? 'mouse';
      this.pointerId = init.pointerId ?? 1;
    }
  }
  // @ts-expect-error test polyfill
  window.PointerEvent = PointerEventPolyfill;
}
