import { readFileSync, writeFileSync } from 'node:fs';

const map = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (map.sourcesContent) {
  delete map.sourcesContent;
  writeFileSync(process.argv[2], JSON.stringify(map), 'utf8');
}
