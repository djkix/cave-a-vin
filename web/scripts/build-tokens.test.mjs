import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensToCss } from './build-tokens.mjs';

test('flattens groups into --group-name custom properties', () => {
  const css = tokensToCss({ color: { primary: { $value: '#7A5522' }, 'primary-action': { $value: '#8B612C' } }, space: { md: { $value: '16px' } } });
  assert.match(css, /--color-primary: #7A5522;/);
  assert.match(css, /--color-primary-action: #8B612C;/);
  assert.match(css, /--space-md: 16px;/);
  assert.match(css, /^:root \{/);
});
