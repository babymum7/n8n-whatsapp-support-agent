// Fast suite: runs the workflows in a clean n8n container with no network.
// Usage: node --test tests/tools.test.mjs   (needs Docker; about 30 seconds)
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'n8nio/n8n:2.45.7';
const LOOKUP_ID = 'waToolPurchases1';
const HARNESS_ID = 'waTestPurchases1';
const WORKFLOW_IDS = [
  'waChannelChat001',
  'waChannelWhatsAp',
  'waKnowledgeIngst',
  'waSupportAgent01',
  'waToolHandoff001',
  'waToolPurchases1',
];
const CATALOG = '=====CATALOG=====';
const LISTED = '=====LISTED=====';
const MARK = '=====EXECUTION=====';

// n8n 2.x runs a sub-workflow only from its published version. With the
// publication service on, a published version becomes callable only after a
// running server processes its outbox; this one-shot CLI has no server, so it
// reads the version `publish:workflow` stores directly.
const SCRIPT = `
fail() { cat /tmp/step.log; exit 3; }
n8n import:workflow --separate --input=/workflows > /tmp/step.log 2>&1 || fail
n8n import:workflow --input=/harness/purchase-lookup.json > /tmp/step.log 2>&1 || fail
n8n export:nodes --output=/tmp/catalog.json > /tmp/step.log 2>&1 || fail
echo '${CATALOG}'
node /harness/check-nodes.mjs /tmp/catalog.json /workflows
echo '${LISTED}'
n8n list:workflow 2>/dev/null
n8n publish:workflow --id=${LOOKUP_ID} > /tmp/step.log 2>&1 || fail
echo '${MARK}'
n8n execute --id=${HARNESS_ID} --rawOutput
`;

function runInN8n(script) {
  const run = spawnSync(
    'docker',
    [
      'run', '--rm', '--network', 'none',
      '-e', 'N8N_USE_WORKFLOW_PUBLICATION_SERVICE=false',
      '-v', `${ROOT}/workflows:/workflows:ro`,
      '-v', `${ROOT}/tests/harness:/harness:ro`,
      '--entrypoint', 'sh', IMAGE, '-c', script,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const output = `${run.stdout}${run.stderr}`;
  if (run.status !== 0) throw new Error(`n8n container exited ${run.status}:\n${output.slice(-4000)}`);
  return output;
}

// `n8n execute` prints the execution as indented JSON among log lines.
function executionFrom(output) {
  const lines = output.slice(output.indexOf(MARK)).split('\n');
  const start = lines.indexOf('{');
  const end = lines.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error(`no execution JSON in output:\n${output.slice(-4000)}`);
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

function nodeOutput(execution, node) {
  const runs = execution.data.resultData.runData[node];
  assert.ok(runs, `node "${node}" did not run`);
  return runs[0].data.main[0].map((item) => item.json);
}

function section(output, mark, next) {
  return output.slice(output.indexOf(mark) + mark.length, output.indexOf(next)).trim().split('\n');
}

let results;
let catalog;
let listed;

before(() => {
  const output = runInN8n(SCRIPT);
  catalog = JSON.parse(section(output, CATALOG, LISTED).at(-1));
  // `n8n list:workflow` prints one `<id>|<name>` line per workflow.
  listed = section(output, LISTED, MARK)
    .filter((line) => /^\w+\|/.test(line))
    .map((line) => line.split('|')[0])
    .filter((id) => id !== HARNESS_ID)
    .sort();
  const execution = executionFrom(output);
  assert.equal(execution.data.resultData.error, undefined, JSON.stringify(execution.data.resultData.error));
  results = Object.fromEntries(nodeOutput(execution, 'Results').map((r) => [r.case, r.result]));
});

test('all six workflows import into n8n 2.45.7', () => {
  assert.deepEqual(listed, WORKFLOW_IDS);
});

test('every node uses a type and typeVersion that n8n 2.45.7 ships', () => {
  assert.deepEqual(catalog.missing, []);
});

const ASHA_PAYMENTS = ['pay_Qd7Lm2Xa9Kp4Tz', 'pay_Qd7Kx8Rb3Nw6Hc'];

for (const phoneCase of ['asha-international', 'asha-whatsapp', 'asha-local']) {
  test(`purchase lookup finds only Asha's payments (${phoneCase})`, () => {
    const result = results[phoneCase];
    assert.equal(result.found, true);
    assert.deepEqual(result.purchases.map((p) => p.payment_id).sort(), [...ASHA_PAYMENTS].sort());
    for (const purchase of result.purchases) {
      assert.equal(purchase.product, '21-Day Breathwork Reset');
      assert.equal(purchase.amount_inr, '₹1,499');
    }
    assert.deepEqual(result.purchases.map((p) => p.status).sort(), ['captured', 'failed']);
  });
}

for (const phoneCase of ['unknown', 'empty']) {
  test(`purchase lookup finds nothing for an ${phoneCase} phone`, () => {
    assert.deepEqual(results[phoneCase], { found: false, purchases: [] });
  });
}
