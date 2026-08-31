
import { randomUUID } from 'node:crypto';

if (typeof global.crypto === 'undefined') {
  Object.defineProperty(global, 'crypto', {
    value: {},
    configurable: true,
  });
}

if (typeof global.crypto.randomUUID !== 'function') {
  Object.defineProperty(global.crypto, 'randomUUID', {
    value: randomUUID,
    configurable: true,
  });
}

import '@testing-library/jest-dom';
import React from 'react';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    priority: _priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    fill?: boolean;
    priority?: boolean;
  }) => React.createElement('img', props),
}));
