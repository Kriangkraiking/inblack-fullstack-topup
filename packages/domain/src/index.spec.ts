import { expect, it } from 'vitest';
import { DOMAIN_PACKAGE_NAME } from './index.js';

it('exposes the package name', () => {
  expect(DOMAIN_PACKAGE_NAME).toBe('@inblack/domain');
});
