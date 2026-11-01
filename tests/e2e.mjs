// Slow end-to-end run: starts n8n and Ollama with Docker Compose, loads every
// workflow, waits until the FAQ is embedded, then holds four scripted chats with
// a live model through the hosted chat and checks the replies and executions.
//
//   LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=... LLM_MODEL=gpt-5-mini node tests/e2e.mjs
//
// Needs Docker and network access and takes a few minutes. It runs as Compose
// project `n8n-wa-e2e` on 127.0.0.1:5688 and writes the chats to
// tests/out/e2e-transcript.md. When it ends it deletes the project's n8n data,
// unless KEEP_STACK=1 leaves the stack running so you can look around in n8n.
// The API key reaches n8n over stdin and is stored only in n8n's encrypted
// credential store.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'n8n-wa-e2e';
const PORT = 5688;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TRANSCRIPT = join(ROOT, 'tests/out/e2e-transcript.md');
// Sub-workflows run from their published version, so every workflow the chat
// reaches is published; the WhatsApp channel stays unpublished.
const PUBLISH = ['waToolPurchases1', 'waToolHandoff001', 'waSupportAgent01', 'waKnowledgeIngst', 'waChannelChat001'];
const ASHA_CAPTURED_PAYMENT = 'pay_Qd7Lm2Xa9Kp4Tz';
const KEEP_STACK = process.env.KEEP_STACK === '1';

const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
  console.error('Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL for an OpenAI-compatible Chat Completions endpoint.');
  process.exit(2);
}

const chatWorkflow = JSON.parse(readFileSync(join(ROOT, 'workflows/channel-chat.json'), 'utf8'));
const CHAT_URL = `${BASE_URL}/webhook/${chatWorkflow.nodes.find((node) => node.type.endsWith('.chatTrigger')).webhookId}/chat`;

const SCENARIOS = [
  {
    id: 'hours',
    title: 'An English question is answered from the knowledge base',
    session: 'e2e-hours',
    messages: ['When is your support team available?'],
    check: ({ reply }) => [
      { name: 'reply states the 18:30 IST closing time', pass: /18:30|6:30\s*p\.?\s*m/i.test(reply) },
    ],
  },
  {
    id: 'hindi',
    title: 'A Hindi question gets a Hindi answer from the knowledge base',
    session: 'e2e-hindi',
    messages: ['मुझे रिफंड माँगने के लिए कितने दिन मिलते हैं?'],
    check: ({ reply }) => {
      const share = devanagariShare(reply);
      return [
        { name: 'at least half of the letters are Devanagari', pass: share >= 0.5, detail: `${Math.round(share * 100)}%` },
        { name: 'reply states the 11-day window', pass: /11|११/.test(reply) },
      ];
    },
  },
  {
    id: 'payment',
    title: "A purchase question quotes the caller's own payment",
    session: 'e2e-payment',
    messages: ['Hi, I paid for the 21-Day Breathwork Reset on 28 October. Did my payment go through?'],
    check: async ({ reply, before }) => {
      const lookups = await settle(() => successfulRuns('waToolPurchases1', before));
      return [
        { name: 'tool-purchase-lookup ran successfully', pass: lookups.length > 0, detail: `${lookups.length} run(s)` },
        { name: `reply quotes ${ASHA_CAPTURED_PAYMENT}`, pass: reply.includes(ASHA_CAPTURED_PAYMENT) },
      ];
    },
  },
  {
    id: 'refund',
    title: 'A refund request becomes a ticket',
    session: 'e2e-refund',
    messages: [
      "I'd like a refund for the 21-Day Breathwork Reset, please. It isn't right for me.",
      'Yes, please go ahead and open the refund request. I just do not have time for the program.',
    ],
    done: (reply) => /TKT-\d+/.test(reply),
    check: async ({ reply, before, ticketsBefore }) => {
      const handoffs = await settle(() => successfulRuns('waToolHandoff001', before));
      const added = ticketRows().slice(ticketsBefore.length);
      const ticket = reply.match(/TKT-(\d+)/);
      return [
        { name: 'tool-handoff ran successfully', pass: handoffs.length > 0, detail: `${handoffs.length} run(s)` },
        {
          name: 'a row was added to the support_tickets Data Table',
          pass: added.length > 0,
          detail: added.map((row) => `id ${row.id}, kind ${row.kind}, status ${row.status}`).join('; '),
        },
        { name: 'reply gives a TKT-<number> ticket id', pass: Boolean(ticket), detail: ticket?.[0] },
        {
          name: 'the ticket id matches the added row',
          pass: Boolean(ticket) && added.some((row) => String(row.id) === ticket[1]),
        },
      ];
    },
  },
];

// Runs inside the n8n container: reads n8n's SQLite database and execution data.
const DB_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const { parse } = require('/usr/local/lib/node_modules/n8n/node_modules/flatted');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { timeout: 5000 });
const [command, arg] = process.argv.slice(1);
const executions = (where, ...params) => db
  .prepare('SELECT e.id, e.workflowId, e.mode, e.status, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id WHERE ' + where)
  .all(...params)
  .map((row) => ({ ...row, data: parse(row.data) }));
let result;
if (command === 'query') result = db.prepare(arg).all();
if (command === 'agent') {
  result = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false, toolRuns: {} };
  for (const { data } of executions("e.workflowId = 'waSupportAgent01' AND e.id > ?", Number(arg))) {
    for (const [node, runs] of Object.entries(data.resultData.runData)) {
      if (node === 'Chat model') {
        for (const run of runs) {
          const output = (((run.data || {}).ai_languageModel || [])[0] || [])[0];
          const json = (output && output.json) || {};
          const usage = json.tokenUsage || json.tokenUsageEstimate;
          result.modelCalls += 1;
          if (!usage) continue;
          result.promptTokens += usage.promptTokens || 0;
          result.completionTokens += usage.completionTokens || 0;
          if (!json.tokenUsage) result.estimated = true;
        }
      } else if (['search_faq', 'lookup_purchases', 'hand_off'].includes(node)) {
        result.toolRuns[node] = runs.length;
      }
    }
  }
}
if (command === 'errors') {
  result = [];
  for (const row of executions("e.status NOT IN ('success', 'running', 'waiting', 'new') ORDER BY e.id DESC LIMIT 6")) {
    const resultData = row.data.resultData;
    result.push('execution ' + row.id + ' of ' + row.workflowId + ' (' + row.mode + ') ' + row.status + ', last node ' + resultData.lastNodeExecuted);
    if (resultData.error) result.push('  ' + resultData.error.message + ' ' + (resultData.error.description || ''));
    for (const [node, runs] of Object.entries(resultData.runData || {})) {
      for (const run of runs) if (run.error) result.push('  ' + node + ': ' + run.error.message + ' ' + (run.error.description || ''));
    }
  }
}
process.stdout.write(JSON.stringify(result));
`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (line) => console.log(`[e2e] ${line}`);
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

function compose(args, { input, check = true } = {}) {
  const { LLM_API_KEY: _key, ...env } = process.env;
  const run = spawnSync('docker', ['compose', '-p', PROJECT, '-f', join(ROOT, 'docker-compose.yml'), ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, N8N_HOST_PORT: `127.0.0.1:${PORT}` }, // the public chat stays off the LAN
  });
  if (check && run.status !== 0) {
    throw new Error(`docker compose ${args[0]} exited ${run.status}:\n${`${run.stdout}${run.stderr}`.slice(-3000)}`);
  }
  return run;
}

function db(command, arg = '') {
  return JSON.parse(compose(['exec', '-T', 'n8n', 'node', '--no-warnings', '-e', DB_SCRIPT, command, String(arg)]).stdout);
}

const sql = (query) => db('query', query);
const latestExecutionId = () => sql('SELECT COALESCE(MAX(id), 0) AS id FROM execution_entity')[0].id;
const successfulRuns = (workflowId, after) =>
  sql(`SELECT id FROM execution_entity WHERE workflowId = '${workflowId}' AND id > ${after} AND status = 'success'`);

function ticketRows() {
  const [table] = sql("SELECT id FROM data_table WHERE name = 'support_tickets'");
  return table ? sql(`SELECT * FROM "data_table_user_${table.id}" ORDER BY id`) : [];
}

async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    await sleep(2000);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

// Sub-workflow executions are saved a moment after the chat reply returns.
async function settle(probe, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  let rows = probe();
  while (rows.length === 0 && Date.now() < deadline) {
    await sleep(1000);
    rows = probe();
  }
  return rows;
}

function devanagariShare(text) {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  return letters.length ? letters.filter((char) => /\p{Script=Devanagari}/u.test(char)).length / letters.length : 0;
}

function removeStack() {
  compose(['down', '--remove-orphans'], { check: false });
  spawnSync('docker', ['volume', 'rm', '-f', `${PROJECT}_n8n_data`], { encoding: 'utf8' });
}

// The model id goes only into this temporary copy; the repository keeps gpt-5-mini.
function copyWorkflows() {
  const workdir = mkdtempSync(join(tmpdir(), 'n8n-wa-e2e-'));
  chmodSync(workdir, 0o755); // read by the container's user; holds no secrets
  mkdirSync(join(workdir, 'workflows'));
  for (const file of readdirSync(join(ROOT, 'workflows')).filter((name) => name.endsWith('.json'))) {
    const workflow = JSON.parse(readFileSync(join(ROOT, 'workflows', file), 'utf8'));
    for (const node of workflow.nodes) {
      if (node.type === '@n8n/n8n-nodes-langchain.lmChatOpenAi') node.parameters.model.value = LLM_MODEL;
    }
    writeFileSync(join(workdir, 'workflows', file), JSON.stringify(workflow));
  }
  return workdir;
}

function importWorkflows(workdir) {
  const credentials = [
    { id: 'waLlmOpenAiCompt', name: 'LLM (OpenAI-compatible)', type: 'openAiApi', data: { apiKey: LLM_API_KEY, url: LLM_BASE_URL } },
    { id: 'waOllamaLocal001', name: 'Ollama (local)', type: 'ollamaApi', data: { baseUrl: 'http://ollama:11434' } },
  ];
  const script = [
    'set -e',
    'umask 077',
    'cat > /tmp/credentials.json',
    'n8n import:credentials --input=/tmp/credentials.json',
    'rm /tmp/credentials.json',
    'n8n import:workflow --separate --input=/e2e/workflows',
    ...PUBLISH.map((id) => `n8n publish:workflow --id=${id}`),
  ].join('\n');
  compose(['run', '--rm', '--no-deps', '-T', '-v', `${workdir}:/e2e:ro`, '--entrypoint', 'sh', 'n8n', '-c', script], {
    input: JSON.stringify(credentials),
  });
}

async function chat(sessionId, chatInput) {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'sendMessage', sessionId, chatInput }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`hosted chat answered HTTP ${response.status}: ${body.slice(0, 500)}`);
  const json = JSON.parse(body);
  const reply = (Array.isArray(json) ? json[0] : json)?.output;
  if (typeof reply !== 'string') throw new Error(`hosted chat reply has no output: ${body.slice(0, 500)}`);
  return reply;
}

async function runScenario(scenario) {
  const before = latestExecutionId();
  const ticketsBefore = ticketRows();
  const turns = [];
  for (const message of scenario.messages) {
    const reply = await chat(scenario.session, message);
    turns.push({ customer: message, reply });
    log(`${scenario.id} customer: ${message}`);
    log(`${scenario.id} assistant: ${reply.replace(/\n+/g, ' / ')}`);
    if (!scenario.done || scenario.done(reply)) break;
  }
  const checks = await scenario.check({ reply: turns.at(-1).reply, before, ticketsBefore });
  const agent = db('agent', before);
  const pass = checks.every((check) => check.pass);
  log(`${scenario.id} ${pass ? 'pass' : 'FAIL'}`);
  return { ...scenario, turns, checks, agent, pass };
}

function redact(text) {
  let host = '';
  try {
    host = new URL(LLM_BASE_URL).host;
  } catch {}
  return [LLM_API_KEY, LLM_BASE_URL, host].filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

function writeTranscript({ results, modes, failure }) {
  const lines = [
    '# End-to-end run',
    '',
    `- When: ${new Date().toISOString()}`,
    `- Stack: \`docker-compose.yml\` (n8n 2.45.7, Ollama 0.40.13 with \`nomic-embed-text\`); chat model \`${LLM_MODEL}\` through an OpenAI-compatible Chat Completions endpoint`,
    `- Execution modes: hosted chat \`${modes.chat ?? 'n/a'}\`, support agent \`${modes.agent ?? 'n/a'}\`, tools \`${modes.tools ?? 'n/a'}\`; knowledge-ingest runs: ${modes.ingestRuns ?? 'n/a'}`,
    `- Result: ${!failure && results.length === SCENARIOS.length && results.every((r) => r.pass) ? 'all checks pass' : 'FAILED'}`,
  ];
  for (const [index, result] of results.entries()) {
    lines.push('', `## ${index + 1}. ${result.title} (${result.pass ? 'pass' : 'FAIL'})`, '');
    for (const turn of result.turns) {
      lines.push(`**Customer:** ${turn.customer}`, '', '**Assistant:**', '', ...turn.reply.split('\n').map((line) => `> ${line}`), '');
    }
    for (const check of result.checks) {
      lines.push(`- ${check.pass ? 'pass' : 'FAIL'}: ${check.name}${check.detail ? ` (${check.detail})` : ''}`);
    }
    const { modelCalls, promptTokens, completionTokens, estimated, toolRuns } = result.agent;
    const tools = Object.entries(toolRuns).map(([tool, runs]) => `${tool} ×${runs}`).join(', ') || 'none';
    lines.push(
      `- Agent: ${modelCalls} model call(s), ${promptTokens} prompt and ${completionTokens} completion tokens${estimated ? ' (estimated)' : ''}; tools used: ${tools}`,
    );
  }
  if (failure) lines.push('', '## Run stopped', '', '```', failure.message, '```');
  mkdirSync(dirname(TRANSCRIPT), { recursive: true });
  writeFileSync(TRANSCRIPT, `${redact(lines.join('\n'))}\n`);
}

const results = [];
const modes = {};
let workdir;
let failure;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    removeStack();
    process.exit(1);
  });
}
try {
  log('removing any stack left by an earlier run');
  removeStack();
  workdir = copyWorkflows();
  log('importing credentials and workflows, publishing five of them');
  importWorkflows(workdir);
  log('starting n8n and Ollama (the first run downloads nomic-embed-text)');
  compose(['up', '-d']);
  await until('n8n to answer /healthz', 600, async () => (await fetch(`${BASE_URL}/healthz`)).ok);
  await until('the hosted chat webhook', 120, async () => (await fetch(CHAT_URL)).ok);
  log('waiting for knowledge-ingest to embed the FAQ');
  const ingestRuns = () => sql("SELECT id, status FROM execution_entity WHERE workflowId = 'waKnowledgeIngst' ORDER BY id");
  await until('knowledge-ingest to succeed', 300, () => {
    const latest = ingestRuns().at(-1);
    if (latest && !['success', 'running', 'new', 'waiting'].includes(latest.status)) {
      throw fatal(`knowledge-ingest ended with status ${latest.status}`);
    }
    return latest?.status === 'success';
  });
  // Each ingest clears the store first, so a later one would empty it mid-chat.
  const ingested = ingestRuns();
  await sleep(20_000);
  const settled = ingestRuns();
  if (settled.length !== ingested.length || settled.at(-1).status !== 'success') {
    throw new Error(`knowledge-ingest ran again after its first success: ${JSON.stringify(settled)}`);
  }
  modes.ingestRuns = settled.length;
  for (const scenario of SCENARIOS) results.push(await runScenario(scenario));
  modes.chat = sql("SELECT DISTINCT mode FROM execution_entity WHERE workflowId = 'waChannelChat001'").map((row) => row.mode).join(', ');
  modes.agent = sql("SELECT DISTINCT mode FROM execution_entity WHERE workflowId = 'waSupportAgent01'").map((row) => row.mode).join(', ');
  modes.tools = sql("SELECT DISTINCT mode FROM execution_entity WHERE workflowId IN ('waToolPurchases1', 'waToolHandoff001')")
    .map((row) => row.mode)
    .join(', ');
} catch (error) {
  failure = error;
  console.error(`[e2e] stopped: ${error.message}`);
  try {
    for (const line of db('errors')) console.error(`[e2e] ${line}`);
  } catch {}
  console.error(compose(['logs', '--no-color', '--tail', '40', 'n8n'], { check: false }).stdout);
} finally {
  writeTranscript({ results, modes, failure });
  if (KEEP_STACK) {
    log(`stack left running at ${BASE_URL}; remove it with: docker compose -p ${PROJECT} down && docker volume rm ${PROJECT}_n8n_data`);
  } else {
    removeStack();
  }
  if (workdir) rmSync(workdir, { recursive: true, force: true });
}

const passed = !failure && results.length === SCENARIOS.length && results.every((result) => result.pass);
log(`${passed ? 'all checks pass' : 'FAILED'}; transcript in ${TRANSCRIPT}`);
process.exitCode = passed ? 0 : 1;
