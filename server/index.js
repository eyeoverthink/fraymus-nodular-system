import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  generateImage,
  imageBuffer,
  removeImageBackground,
  upscaleImage,
} from './ai.js';
import { authenticate, getBearerToken } from './auth.js';
import { DEFAULT_EDGES, DEFAULT_NODES, executeWorkflow, suggestNextNode, topologicalOrder } from './workflow.js';
import { WorkflowStore } from './storage.js';

try {
  process.loadEnvFile?.();
} catch {
  // A local .env file is optional; deployments provide environment variables.
}

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC = resolve(ROOT, 'public');
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MODEL_PROMPT = 'Create a polished commercial product photograph with soft studio lighting.';
const scryptAsync = promisify(scrypt);

function respond(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const buffer = await readBody(request);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
  }
}

function validateDefinition(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length < 1 || nodes.length > 30 || edges.length > 100) {
    throw Object.assign(new Error('A workflow must contain 1–30 nodes and no more than 100 edges'), { status: 400 });
  }
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length > 100 || ids.has(node.id)) {
      throw Object.assign(new Error('Every node must have a unique string id'), { status: 400 });
    }
    if (!['llama', 'flux', 'remover', 'upscaler', 'preview'].includes(node.type)) {
      throw Object.assign(new Error(`Unknown workflow node type: ${node.type}`), { status: 400 });
    }
    if (node.data?.systemPrompt !== undefined &&
        (typeof node.data.systemPrompt !== 'string' || node.data.systemPrompt.length > 8000)) {
      throw Object.assign(new Error('System prompts must be text no longer than 8,000 characters'), { status: 400 });
    }
    ids.add(node.id);
  }
  for (const edge of edges) {
    if (!ids.has(edge?.source) || !ids.has(edge?.target)) {
      throw Object.assign(new Error('Every edge must connect two existing nodes'), { status: 400 });
    }
  }
  try {
    topologicalOrder(nodes, edges);
  } catch {
    throw Object.assign(new Error('Workflow edges must not contain a cycle'), { status: 400 });
  }
}

async function loadUser(request, store) {
  const user = await authenticate(request);
  if (user) {
    await store.ensureUser(user);
    return user;
  }
  return null;
}

async function hashKey(key) {
  const salt = process.env.API_KEY_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-development-only';
  return (await scryptAsync(key, salt, 64, { N: 4096, r: 8, p: 1, maxmem: 16 * 1024 * 1024 })).toString('hex');
}

async function getReaSuggestion(nodes) {
  const fallback = suggestNextNode(nodes);
  if (!process.env.GROQ_API_KEY || process.env.MOCK_AI === '1') return fallback;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.GROQ_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Recommend only the next useful workflow node. Return JSON with keys type, label, reason. Allowed node types: llama, flux, remover, upscaler, preview. Do not return code.',
          },
          {
            role: 'user',
            content: JSON.stringify({ currentNodeTypes: nodes.map((node) => node.type), nextExpectedType: fallback.type }),
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const validTypes = new Set(['llama', 'flux', 'remover', 'upscaler', 'preview']);
    if (!validTypes.has(parsed.type) || nodes.some((node) => node.type === parsed.type)) return fallback;
    return {
      type: parsed.type,
      label: String(parsed.label || fallback.label).slice(0, 60),
      reason: String(parsed.reason || fallback.reason).slice(0, 160),
    };
  } catch {
    return fallback;
  }
}

async function meterRun(store, userId, runId) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_METER_EVENT_NAME) return;
  try {
    const customerId = await store.getStripeCustomerId(userId);
    if (!customerId) return;
    const form = new URLSearchParams({
      event_name: process.env.STRIPE_METER_EVENT_NAME,
      identifier: runId,
      'payload[value]': '1',
      'payload[stripe_customer_id]': customerId,
    });
    const response = await fetch('https://api.stripe.com/v1/billing/meter_events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.warn(`Stripe meter event failed: ${response.status}`);
  } catch (error) {
    console.warn(`Stripe meter event failed: ${error.message}`);
  }
}

async function executeAndStore({ store, workflow, userId, body, response }) {
  const runId = randomUUID();
  const startedAt = Date.now();
  await store.createRun({ id: runId, workflowId: workflow.id, userId, status: 'running' });
  try {
    const result = await executeWorkflow({
      nodes: workflow.nodes,
      edges: workflow.edges,
      prompt: String(body.prompt || DEFAULT_MODEL_PROMPT).slice(0, 4000),
      image: body.image || null,
      adapters: {
        brain: async (prompt, systemPrompt) => {
          if (!process.env.GROQ_API_KEY || process.env.MOCK_AI === '1') return prompt;
          const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + process.env.GROQ_API_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [
                { role: 'system', content: systemPrompt || 'Improve this image-generation prompt.' },
                { role: 'user', content: prompt },
              ],
              temperature: 0.7,
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!groqResponse.ok) throw new Error(`Groq returned ${groqResponse.status}`);
          const result = await groqResponse.json();
          return result.choices?.[0]?.message?.content?.trim() || prompt;
        },
        flux: generateImage,
        remover: removeImageBackground,
        upscaler: upscaleImage,
      },
    });
    if (result.upscaled && result.image && result.beforeUpscale) {
      const inputMetadata = await sharp(imageBuffer(result.beforeUpscale), { limitInputPixels: 40_000_000 }).metadata();
      const outputMetadata = await sharp(imageBuffer(result.image), { limitInputPixels: 40_000_000 }).metadata();
      if (inputMetadata.width && inputMetadata.height && outputMetadata.width && outputMetadata.height) {
        response.setHeader('X-Upscale-From', `${inputMetadata.width}x${inputMetadata.height}`);
        response.setHeader('X-Upscale-To', `${outputMetadata.width}x${outputMetadata.height}`);
      }
    }
    const output = {
      runId,
      image: result.image,
      comparisons: {
        beforeRemoval: result.beforeRemoval,
        afterRemoval: result.afterRemoval === result.beforeUpscale ? null : result.afterRemoval,
        beforeUpscale: result.beforeUpscale,
      },
      html: result.html,
      prompt: result.prompt,
      status: 'completed',
      durationMs: Date.now() - startedAt,
    };
    await store.updateRun(runId, userId, {
      status: 'completed',
      output: { image: result.image ? '[image output]' : null, html: result.html },
      durationMs: Date.now() - startedAt,
    });
    await meterRun(store, userId, runId);
    respond(response, 200, output);
  } catch (error) {
    await store.updateRun(runId, userId, {
      status: 'failed',
      error: error.message,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = resolve(PUBLIC, `.${requested}`);
  if (file !== PUBLIC && !file.startsWith(`${PUBLIC}${sep}`)) {
    respond(response, 404, { error: 'Not found' });
    return;
  }
  try {
    const details = await stat(file);
    if (!details.isFile()) throw new Error('not a file');
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    };
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    });
    createReadStream(file).pipe(response);
  } catch {
    respond(response, 404, { error: 'Not found' });
  }
}

export function createAppServer({ store = new WorkflowStore() } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        respond(response, 200, { ok: true, persistence: store.remote ? 'supabase' : 'sqlite' });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        respond(response, 200, {
          authEnabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
          supabaseUrl: process.env.SUPABASE_URL || null,
          supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/billing/checkout') {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to set up billing' });
        if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
          return respond(response, 503, { error: 'Billing is not configured on this server' });
        }
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
        const form = new URLSearchParams({
          mode: 'subscription',
          'line_items[0][price]': process.env.STRIPE_PRICE_ID,
          'line_items[0][quantity]': '1',
          success_url: `${baseUrl}/?billing=success`,
          cancel_url: `${baseUrl}/?billing=cancel`,
          client_reference_id: user.id,
          'metadata[user_id]': user.id,
          'subscription_data[metadata][user_id]': user.id,
          ...(user.email ? { customer_email: user.email } : {}),
        });
        const checkout = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15_000),
        });
        const result = await checkout.json();
        if (!checkout.ok || typeof result.url !== 'string') {
          return respond(response, 502, { error: 'Stripe could not create a checkout session' });
        }
        respond(response, 200, { url: result.url });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/billing/webhook') {
        const rawBody = await readBody(request);
        const signatureHeader = request.headers['stripe-signature'];
        const timestamp = signatureHeader?.match(/(?:^|,)t=(\d+)/)?.[1];
        const signature = signatureHeader?.match(/(?:^|,)v1=([a-f0-9]+)/i)?.[1];
        const age = Math.abs(Date.now() / 1000 - Number(timestamp));
        if (!process.env.STRIPE_WEBHOOK_SECRET || !timestamp || !signature || age > 300) {
          return respond(response, 400, { error: 'Invalid Stripe webhook signature' });
        }
        const expected = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
          .update(`${timestamp}.${rawBody}`)
          .digest();
        const actual = Buffer.from(signature, 'hex');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return respond(response, 400, { error: 'Invalid Stripe webhook signature' });
        }
        let event;
        try {
          event = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return respond(response, 400, { error: 'Invalid Stripe event' });
        }
        if (event.type === 'checkout.session.completed') {
          const session = event.data?.object;
          const userId = session?.client_reference_id || session?.metadata?.user_id;
          const customerId = typeof session?.customer === 'string' ? session.customer : session?.customer?.id;
          if (userId && customerId) {
            await store.ensureUser({ id: userId, email: session.customer_details?.email || null });
            await store.setStripeCustomerId(userId, customerId);
          }
        }
        respond(response, 200, { received: true });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/rea/suggest') {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to get REA suggestions' });
        const body = await readJson(request);
        const suggestion = await getReaSuggestion(Array.isArray(body.nodes) ? body.nodes : []);
        respond(response, 200, { suggestion, codePatch: `Add ${suggestion.type} to the workflow.` });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/workflows') {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to view workflows' });
        respond(response, 200, { workflows: await store.listWorkflows(user.id) });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/workflows') {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to create workflows' });
        const body = await readJson(request);
        const nodes = body.nodes || DEFAULT_NODES;
        const edges = body.edges || DEFAULT_EDGES;
        validateDefinition(nodes, edges);
        const workflow = await store.createWorkflow({
          userId: user.id,
          name: String(body.name || 'My workflow').slice(0, 100),
          nodes,
          edges,
        });
        respond(response, 201, { workflow });
        return;
      }

      const workflowMatch = pathname.match(/^\/api\/workflows\/([a-zA-Z0-9_-]+)(?:\/(run|deploy))?$/);
      if (workflowMatch && request.method === 'GET' && !workflowMatch[2]) {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to view this workflow' });
        const workflow = await store.getWorkflow(workflowMatch[1], user.id);
        return workflow
          ? respond(response, 200, { workflow })
          : respond(response, 404, { error: 'Workflow not found' });
      }

      if (workflowMatch && request.method === 'PATCH' && !workflowMatch[2]) {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to edit this workflow' });
        const body = await readJson(request);
        const current = await store.getWorkflow(workflowMatch[1], user.id);
        if (!current) return respond(response, 404, { error: 'Workflow not found' });
        const nodes = body.nodes ?? current.nodes;
        const edges = body.edges ?? current.edges;
        validateDefinition(nodes, edges);
        const workflow = await store.updateWorkflow(current.id, user.id, {
          name: String(body.name ?? current.name).slice(0, 100),
          nodes,
          edges,
        });
        respond(response, 200, { workflow });
        return;
      }

      if (workflowMatch && request.method === 'DELETE' && !workflowMatch[2]) {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to delete this workflow' });
        const removed = await store.deleteWorkflow(workflowMatch[1], user.id);
        return removed
          ? respond(response, 200, { deleted: true })
          : respond(response, 404, { error: 'Workflow not found' });
      }

      if (workflowMatch && request.method === 'POST' && workflowMatch[2] === 'deploy') {
        const user = await loadUser(request, store);
        if (!user) return respond(response, 401, { error: 'Sign in to deploy workflows' });
        const workflow = await store.getWorkflow(workflowMatch[1], user.id);
        if (!workflow) return respond(response, 404, { error: 'Workflow not found' });
        const apiKey = randomBytes(32).toString('hex');
        await store.updateWorkflow(workflow.id, user.id, {
          deployed: true,
          api_key_hash: await hashKey(apiKey),
        });
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
        respond(response, 200, {
          endpoint: `${baseUrl}/api/workflows/${workflow.id}/run`,
          apiKey,
          curl: `curl -X POST '${baseUrl}/api/workflows/${workflow.id}/run' -H 'Authorization: ` + 'Bearer ' + apiKey + `' -H 'Content-Type: application/json' -d '{"prompt":"A premium product photo"}'`,
        });
        return;
      }

      if (workflowMatch && request.method === 'POST' && workflowMatch[2] === 'run') {
        const body = await readJson(request);
        let workflow;
        let ownerId;
        const key = getBearerToken(request.headers.authorization);
        const authConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
        const user = authConfigured ? await loadUser(request, store) : (key ? null : await loadUser(request, store));
        if (user) {
          workflow = await store.getWorkflow(workflowMatch[1], user.id);
          ownerId = user.id;
        } else {
          if (key) workflow = await store.getDeployedWorkflow(workflowMatch[1], await hashKey(key));
          ownerId = workflow?.user_id;
        }
        if (!workflow) return respond(response, 401, { error: 'Workflow not found or API key invalid' });
        if (body.image !== undefined &&
            (typeof body.image !== 'string' || body.image.length > 12 * 1024 * 1024 ||
             !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(body.image))) {
          return respond(response, 400, { error: 'image must be a base64-encoded PNG, JPEG, or WebP data URL under 12 MB' });
        }
        await executeAndStore({ store, workflow, userId: ownerId, body, response });
        return;
      }

      if (request.method === 'GET' && pathname.startsWith('/api/')) {
        respond(response, 404, { error: 'Not found' });
        return;
      }
      if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
        respond(response, 404, { error: 'Not found' });
        return;
      }
      await serveStatic(pathname, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      respond(response, error.status || 500, {
        error: error.status ? error.message : 'Workflow request failed',
      });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`Fraymus workflow studio listening at http://localhost:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
