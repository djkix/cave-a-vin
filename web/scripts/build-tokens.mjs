import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('src/design-tokens', { recursive: true });
writeFileSync('src/design-tokens/tokens.css', ':root {}\n');
