// Lists workflow nodes whose type or typeVersion this n8n release does not ship.
// Usage: node check-nodes.mjs <catalog from `n8n export:nodes`> <workflow directory>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [catalogPath, workflowDir] = process.argv.slice(2);

const shipped = new Map();
for (const nodeType of JSON.parse(readFileSync(catalogPath, 'utf8'))) {
  const versions = shipped.get(nodeType.name) ?? new Set();
  for (const version of [nodeType.version].flat()) versions.add(Number(version));
  shipped.set(nodeType.name, versions);
}

const missing = [];
for (const file of readdirSync(workflowDir).filter((name) => name.endsWith('.json')).sort()) {
  for (const node of JSON.parse(readFileSync(join(workflowDir, file), 'utf8')).nodes) {
    if (!shipped.get(node.type)?.has(Number(node.typeVersion))) {
      missing.push({ file, node: node.name, type: node.type, typeVersion: node.typeVersion });
    }
  }
}

console.log(JSON.stringify({ missing }));
