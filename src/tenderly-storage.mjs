import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJsonResponse } from './response-boundary.mjs';

const localConfig = fileURLToPath(new URL('../.env.local', import.meta.url));

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

export async function localCredentials() {
  // Process variables override the ignored local file. A separate optional
  // env file can supply credentials without copying them into this checkout.
  const local = parseEnv(await readFile(localConfig, 'utf8').catch(() => ''));
  const config = { ...local, ...process.env };
  const monitorEnv = config.TENDERLY_MONITOR_ENV_FILE
    ? parseEnv(await readFile(config.TENDERLY_MONITOR_ENV_FILE, 'utf8'))
    : {};
  const credentials = { ...monitorEnv, ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '')) };
  for (const name of ['SAFE_API_KEY', 'TENDERLY_ACCESS_KEY']) {
    if (credentials[`${name}_FILE`]) credentials[name] = (await readFile(credentials[`${name}_FILE`], 'utf8')).trim();
  }
  return credentials;
}

export async function monitorConfig() {
  const config = await localCredentials();
  const account = config.TENDERLY_ACCOUNT;
  const project = config.TENDERLY_PROJECT;
  const key = config.TENDERLY_ACCESS_KEY;
  if (!account || !project || !key) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(account) || !/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error('Invalid Tenderly account or project');
  return { account, project, key };
}

export async function fetchMonitorStorage() {
  const config = await monitorConfig();
  if (!config) return null;
  const url = `https://api.tenderly.co/api/v1/account/${config.account}/project/${config.project}/storage/all`;
  const response = await fetch(url, { headers: { Accept: 'application/json', 'X-Access-Key': config.key }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Tenderly monitor storage ${response.status}`);
  const entries = await readJsonResponse(response, 16_000_000);
  if (!Array.isArray(entries)) throw new Error('Unexpected Tenderly monitor storage response');
  const raw = entries.find(entry => entry.key === 'PENDING_TXN_DATA')?.value;
  if (raw == null) throw new Error('Tenderly monitor has no PENDING_TXN_DATA');
  return { PENDING_TXN_DATA: raw };
}
