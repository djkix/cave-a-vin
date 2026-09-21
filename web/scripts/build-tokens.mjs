import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function tokensToCss(tokens) {
  const lines = [];
  for (const [group, entries] of Object.entries(tokens)) {
    for (const [name, token] of Object.entries(entries)) {
      lines.push(`  --${group}-${name}: ${token.$value};`);
    }
  }
  return `:root {\n${lines.join('\n')}\n  --safe-bottom: env(safe-area-inset-bottom, 0px);\n  --safe-top: env(safe-area-inset-top, 0px);\n}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tokens = JSON.parse(readFileSync(join(root, 'src/design-tokens/tokens.json'), 'utf8'));
  mkdirSync(join(root, 'src/design-tokens'), { recursive: true });
  writeFileSync(join(root, 'src/design-tokens/tokens.css'), '/* Généré depuis tokens.json — ne pas éditer */\n' + tokensToCss(tokens));
}
