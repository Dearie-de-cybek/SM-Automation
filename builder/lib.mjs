// Tiny n8n workflow builder: node factories + wiring + static validation.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'code');

export const WORKFLOW_IDS = {
  router: 'smRouter00000001',
  generate: 'smGenerate000001',
  publish: 'smPublish0000001',
  scheduler: 'smScheduler00001',
  errors: 'smErrorHandler01',
};

export const CREDENTIALS = {
  postgres: { postgres: { id: 'smPostgresCred01', name: 'SM App Postgres' } },
  telegram: { telegramApi: { id: 'smTelegramCred01', name: 'SM Telegram Bot' } },
  gemini: { httpHeaderAuth: { id: 'smGeminiKey01', name: 'SM Gemini API Key' } },
  s3: { s3: { id: 'smS3Storage00001', name: 'SM Media Storage' } },
};

const GRID_X = 260;
const GRID_Y = 170;

function uuidFrom(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function pos([col, row]) {
  return [col * GRID_X, row * GRID_Y];
}

export class Workflow {
  constructor({ id, name, settings }) {
    this.id = id;
    this.name = name;
    this.settings = settings;
    this.nodes = [];
    this.connections = {};
  }

  add(node) {
    if (this.nodes.some((n) => n.name === node.name)) throw new Error(`${this.name}: duplicate node "${node.name}"`);
    this.nodes.push({ id: uuidFrom(`${this.id}:${node.name}`), ...node });
    return node.name;
  }

  link(from, to, output = 0) {
    const c = (this.connections[from] ??= { main: [] });
    while (c.main.length <= output) c.main.push([]);
    c.main[output].push({ node: to, type: 'main', index: 0 });
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.link(names[i], names[i + 1]);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      nodes: this.nodes,
      connections: this.connections,
      active: false,
      settings: this.settings,
      pinData: {},
      meta: { templateCredsSetupCompleted: true },
    };
  }
}

// Loads a Code node source file. `// @include path` lines are replaced by that file's contents.
function loadCode(file) {
  const src = readFileSync(join(CODE_DIR, file), 'utf8');
  return src.replace(/^\/\/ @include (\S+)\s*$/gm, (_, inc) => readFileSync(join(CODE_DIR, inc), 'utf8').trim());
}

// ---------- node factories ----------

export function code(name, at, fileOrSource, extra = {}) {
  const jsCode = fileOrSource.endsWith('.js') ? loadCode(fileOrSource) : fileOrSource;
  return { name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(at), parameters: { jsCode }, ...extra };
}

export function pg(name, at, query, paramsExpr, extra = {}) {
  const parameters = { operation: 'executeQuery', query: query.trim(), options: {} };
  if (paramsExpr) parameters.options.queryReplacement = `={{ ${paramsExpr} }}`;
  return {
    name,
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: pos(at),
    parameters,
    credentials: CREDENTIALS.postgres,
    ...extra,
  };
}

// Telegram Bot API call. bodyExpr is a JS object-literal expression (must not contain "}}").
export function tg(name, at, method, bodyExpr, extra = {}) {
  return {
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos(at),
    parameters: {
      method: 'POST',
      url: `=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/${method}`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
      options: {},
    },
    ...extra,
  };
}

const GRAPH = `https://graph.facebook.com/{{ $env.META_GRAPH_VERSION || 'v24.0' }}`;

// Meta Graph API call. path is an n8n template (may contain {{ }}), tokenExpr a JS expression.
export function graph(name, at, { method = 'GET', path, tokenExpr, bodyExpr }, extra = {}) {
  const parameters = {
    method,
    url: `=${GRAPH}/${path}`,
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: `=Bearer {{ ${tokenExpr} }}` }] },
    options: { timeout: 60000 },
  };
  if (bodyExpr) Object.assign(parameters, { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpr}) }}` });
  return { name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(at), parameters, ...extra };
}

export function httpJson(name, at, { url, headers = {}, bodyExpr, credentials, timeout = 60000 }, extra = {}) {
  const parameters = {
    method: 'POST',
    url,
    sendHeaders: true,
    headerParameters: { parameters: Object.entries(headers).map(([n, value]) => ({ name: n, value })) },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
    options: { timeout },
  };
  const node = { name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(at), parameters, ...extra };
  if (credentials) {
    Object.assign(parameters, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' });
    node.credentials = credentials;
  }
  return node;
}

export function ifTrue(name, at, boolExpr) {
  return {
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: pos(at),
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: uuidFrom(`${name}:cond`),
            leftValue: `={{ ${boolExpr} }}`,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };
}

export function switchIndex(name, at, outputs, indexExpr) {
  return {
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: pos(at),
    parameters: { mode: 'expression', numberOutputs: outputs, output: `={{ ${indexExpr} }}` },
  };
}

export function executeWorkflow(name, at, workflowId, { mode = 'once', wait = false } = {}) {
  return {
    name,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position: pos(at),
    parameters: {
      source: 'database',
      workflowId: { __rl: true, value: workflowId, mode: 'id' },
      mode,
      options: { waitForSubWorkflow: wait },
    },
  };
}

export function subworkflowTrigger(name, at) {
  return {
    name,
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: 1.1,
    position: pos(at),
    parameters: { inputSource: 'passthrough' },
  };
}

export function telegramTrigger(name, at, workflowId) {
  return {
    name,
    type: 'n8n-nodes-base.telegramTrigger',
    typeVersion: 1.2,
    position: pos(at),
    webhookId: uuidFrom(`${workflowId}:${name}:webhook`),
    parameters: { updates: ['message', 'callback_query'], additionalFields: {} },
    credentials: CREDENTIALS.telegram,
  };
}

export function telegramDownload(name, at, fileIdExpr) {
  return {
    name,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: pos(at),
    parameters: { resource: 'file', operation: 'get', fileId: `={{ ${fileIdExpr} }}`, download: true, additionalFields: {} },
    credentials: CREDENTIALS.telegram,
  };
}

export function s3Upload(name, at, { bucketExpr, keyExpr }) {
  return {
    name,
    type: 'n8n-nodes-base.s3',
    typeVersion: 1,
    position: pos(at),
    parameters: {
      resource: 'file',
      operation: 'upload',
      bucketName: `={{ ${bucketExpr} }}`,
      fileName: `={{ ${keyExpr} }}`,
      binaryData: true,
      binaryPropertyName: 'data',
      additionalFields: {},
    },
    credentials: CREDENTIALS.s3,
  };
}

export function waitSeconds(name, at, seconds) {
  return {
    name,
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position: pos(at),
    webhookId: uuidFrom(`${name}:wait`),
    parameters: { amount: seconds, unit: 'seconds' },
  };
}

export function scheduleEveryMinutes(name, at, minutes) {
  return {
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: pos(at),
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } },
  };
}

export function errorTrigger(name, at) {
  return { name, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: pos(at), parameters: {} };
}

// ---------- validation ----------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function* stringsIn(value, path = '') {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* stringsIn(value[i], `${path}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* stringsIn(v, `${path}.${k}`);
}

export function validate(wf) {
  const errors = [];
  const names = new Set(wf.nodes.map((n) => n.name));
  const refCheck = (node, text) => {
    for (const m of text.matchAll(/\$\('([^']+)'\)/g)) {
      if (!names.has(m[1])) errors.push(`${wf.name} › ${node}: references missing node "${m[1]}"`);
    }
  };

  for (const [from, { main }] of Object.entries(wf.connections)) {
    if (!names.has(from)) errors.push(`${wf.name}: connection from missing node "${from}"`);
    main.flat().forEach((c) => names.has(c.node) || errors.push(`${wf.name}: connection to missing node "${c.node}"`));
  }

  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      try {
        new AsyncFunction(node.parameters.jsCode);
      } catch (e) {
        errors.push(`${wf.name} › ${node.name}: JS syntax error: ${e.message}`);
      }
      refCheck(node.name, node.parameters.jsCode);
      continue;
    }
    for (const [path, str] of stringsIn(node.parameters)) {
      if (!str.startsWith('=')) {
        // Without the leading "=", n8n sends "{{ … }}" literally.
        if (str.includes('{{')) errors.push(`${wf.name} › ${node.name}${path}: contains {{ }} but is not an expression (missing leading "=")`);
        continue;
      }
      for (const m of str.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
        try {
          new Function(`return (${m[1]});`);
        } catch (e) {
          errors.push(`${wf.name} › ${node.name}${path}: expression syntax error: ${e.message}\n    ${m[1].trim()}`);
        }
        refCheck(node.name, m[1]);
      }
    }
  }

  const targets = new Set(Object.values(wf.connections).flatMap((c) => c.main.flat().map((x) => x.node)));
  const triggers = wf.nodes.filter((n) => /Trigger$/i.test(n.type)).map((n) => n.name);
  for (const n of wf.nodes) {
    if (!targets.has(n.name) && !triggers.includes(n.name)) errors.push(`${wf.name}: node "${n.name}" has no input`);
  }
  return errors;
}
