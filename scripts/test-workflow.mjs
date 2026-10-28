import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const directory = await mkdtemp(join(tmpdir(), 'fraymus-workflow-'));
const port = await unusedPort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  SQLITE_PATH: join(directory, 'workflow.sqlite'),
  MOCK_AI: '1',
  ALLOWED_ORIGINS: 'https://studio.base44.app',
  PUBLIC_API_URL: 'https://api.fraymus.test',
};
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY', 'HF_TOKEN', 'REPLICATE_API_TOKEN']) {
  delete env[name];
}

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
  throw new Error(`Server did not start:\n${serverOutput}`);
}

try {
  await waitForServer();
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(health.persistence, 'sqlite');
  const configResponse = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: 'https://studio.base44.app' },
  });
  const config = await configResponse.json();
  assert.equal(config.apiBaseUrl, 'https://api.fraymus.test');
  assert.equal(configResponse.headers.get('access-control-allow-origin'), 'https://studio.base44.app');
  const preflight = await fetch(`${baseUrl}/api/workflows`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://studio.base44.app',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
  const deniedOrigin = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(deniedOrigin.status, 403);

  const created = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Five node test' }),
  }).then((response) => response.json());
  assert.equal(created.workflow.nodes.length, 5);
  assert.equal(created.workflow.edges.length, 4);

  const runResponse = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'A test product image' }),
  });
  const result = await runResponse.json();
  assert.equal(runResponse.status, 200, JSON.stringify(result));
  assert.equal(result.status, 'completed');
  assert.match(result.image, /^data:image\/png;base64,/);
  assert.match(result.html, /<img/);
  assert.equal(runResponse.headers.get('x-upscale-to'), '4096x4096');
  const metadata = await sharp(Buffer.from(result.image.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, 4096);
  assert.equal(metadata.height, 4096);

  const uploadedPng = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#7c67e9' } })
    .png()
    .toBuffer();
  const uploadedDataUrl = `data:image/png;base64,${uploadedPng.toString('base64')}`;
  const uploadResponse = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Uploaded product image', image: uploadedDataUrl }),
  });
  const uploadResult = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(uploadResult.comparisons.beforeRemoval, uploadedDataUrl);
  assert.equal(uploadResponse.headers.get('x-upscale-from'), '4x3');
  assert.equal(uploadResponse.headers.get('x-upscale-to'), '16x12');

  const deployed = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/deploy`, {
    method: 'POST',
  }).then((response) => response.json());
  const publicRun = await fetch(deployed.endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + deployed.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Deployed request' }),
  });
  assert.equal(publicRun.status, 200);
  const deniedRun = await fetch(deployed.endpoint, {
    method: 'POST',
    headers: { Authorization: ['Bearer', 'wrong-test-key'].join(' '), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Should not run' }),
  });
  assert.equal(deniedRun.status, 401);

  const suggestion = await fetch(`${baseUrl}/api/rea/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes: [{ id: 'brain', type: 'llama' }], edges: [] }),
  }).then((response) => response.json());
  assert.equal(suggestion.suggestion.type, 'flux');
  console.log('5-node workflow, upscale dimensions, deploy auth, and REA suggestion passed');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 3000).unref();
  });
  await rm(directory, { recursive: true, force: true });
}
