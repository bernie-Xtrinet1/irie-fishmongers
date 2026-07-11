import '@testing-library/jest-dom';

// jsdom implements neither the Pointer Events capture API nor
// scrollIntoView, both of which Radix UI's Select/AlertDialog rely on -
// without these stubs, interacting with those components under jsdom
// throws or silently no-ops.
if (!window.HTMLElement.prototype.hasPointerCapture) {
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => undefined;
  window.HTMLElement.prototype.releasePointerCapture = () => undefined;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
}
