#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'unit-versions-agent.config.json');
const DEFAULT_ENDPOINT = 'https://pr-sistemas-base-conhecimento.onrender.com/api/unit-versions/ingest';
const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_RETRY_MS = 10000;

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || DEFAULT_CONFIG_PATH);
const runtimeConfig = await loadConfig(configPath, args);

let inFlight = false;
let timer = null;
let lastSignature = '';
let watchInitialized = false;

main().catch(error => {
  console.error('[unit-versions-agent] erro fatal:', error);
  process.exitCode = 1;
});

async function main() {
  log(`config carregada de ${configPath}`);
  log(`endpoint: ${runtimeConfig.endpoint}`);

  if (!runtimeConfig.token) {
    throw new Error('token ausente. Defina "token" no arquivo de configuracao ou via --token.');
  }

  if (runtimeConfig.watch && runtimeConfig.sourcePath) {
    startWatcher();
  }

  await runOnce();

  if (runtimeConfig.once) {
    return;
  }

  scheduleNext(runtimeConfig.pollIntervalMs);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runOnce() {
  if (inFlight) return null;
  inFlight = true;

  try {
    const payload = await loadPayload();
    const signature = stableStringify(payload);

    if (signature === lastSignature) {
      log('nenhuma mudanca detectada');
      return;
    }

    const response = await postPayload(payload);
    lastSignature = signature;

    log(`enviado com sucesso. ${response.processed || 0} registro(s) processado(s).`);
    return true;
  } catch (error) {
    console.error('[unit-versions-agent] falha ao enviar:', error.message || error);
    return false;
  } finally {
    inFlight = false;
  }
}

function scheduleNext(delayMs) {
  if (runtimeConfig.once) return;

  clearTimeout(timer);
  timer = setTimeout(async () => {
    const result = await runOnce();
    if (result === null) {
      scheduleNext(runtimeConfig.pollIntervalMs);
      return;
    }
    scheduleNext(result ? runtimeConfig.pollIntervalMs : runtimeConfig.retryIntervalMs);
  }, delayMs);
}

function startWatcher() {
  if (watchInitialized) return;
  watchInitialized = true;

  const watchedPath = runtimeConfig.sourcePath;
  let debounceTimer = null;

  try {
    fs.watch(watchedPath, { persistent: true }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runOnce().catch(error => {
          console.error('[unit-versions-agent] falha no watcher:', error);
        });
      }, 750);
    });

    log(`watch ativo em ${watchedPath}`);
  } catch (error) {
    console.error(`[unit-versions-agent] nao foi possivel observar ${watchedPath}:`, error.message || error);
  }
}

async function loadPayload() {
  if (runtimeConfig.command) {
    return loadPayloadFromCommand(runtimeConfig.command, runtimeConfig.commandCwd);
  }

  if (!runtimeConfig.sourcePath) {
    throw new Error('defina sourcePath ou command no arquivo de configuracao.');
  }

  return loadPayloadFromFile(runtimeConfig.sourcePath);
}

async function loadPayloadFromFile(filePath) {
  const content = await fsp.readFile(filePath, 'utf8');
  return parseJsonMaybe(content, filePath);
}

function loadPayloadFromCommand(command, cwd) {
  const output = execSync(command, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true
  });

  return parseJsonMaybe(output, 'command output');
}

function parseJsonMaybe(value, sourceLabel) {
  if (value && typeof value === 'object') {
    return value;
  }

  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`conteudo vazio em ${sourceLabel}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`o conteudo em ${sourceLabel} nao e JSON valido`);
  }
}

async function postPayload(payload) {
  const response = await fetch(runtimeConfig.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${runtimeConfig.token}`,
      'x-unit-versions-token': runtimeConfig.token
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function loadConfig(filePath, cliArgs) {
  const fileConfig = await readConfigFile(filePath);
  const merged = {
    endpoint: DEFAULT_ENDPOINT,
    token: '',
    sourcePath: '',
    command: '',
    commandCwd: '',
    pollIntervalMs: DEFAULT_INTERVAL_MS,
    retryIntervalMs: DEFAULT_RETRY_MS,
    watch: false,
    once: false,
    ...fileConfig,
    ...cliArgs
  };

  const baseDir = path.dirname(filePath);

  return {
    endpoint: String(merged.endpoint || DEFAULT_ENDPOINT).trim(),
    token: String(merged.token || '').trim(),
    sourcePath: merged.sourcePath ? path.resolve(baseDir, String(merged.sourcePath)) : '',
    command: String(merged.command || '').trim(),
    commandCwd: merged.commandCwd ? path.resolve(baseDir, String(merged.commandCwd)) : '',
    pollIntervalMs: normalizeInterval(merged.pollIntervalMs, DEFAULT_INTERVAL_MS, 10000),
    retryIntervalMs: normalizeInterval(merged.retryIntervalMs, DEFAULT_RETRY_MS, 5000),
    watch: toBoolean(merged.watch),
    once: toBoolean(merged.once)
  };
}

async function readConfigFile(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return parseJsonMaybe(content, filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function normalizeInterval(value, fallback, minimum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.max(Math.floor(numeric), minimum);
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(text);
}

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;

    const [flag, inlineValue] = item.split('=', 2);
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }

  return result;
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function log(message) {
  console.log(`[unit-versions-agent] ${message}`);
}

function shutdown() {
  clearTimeout(timer);
  log('encerrando');
  process.exit(0);
}
