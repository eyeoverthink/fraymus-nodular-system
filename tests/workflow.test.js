import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EDGES, DEFAULT_NODES, executeWorkflow, topologicalOrder } from '../server/workflow.js';
import { WorkflowStore } from '../server/storage.js';

test('topological order follows the workflow edges', () => {
  const nodes = [{ id: 'last' }, { id: 'first' }, { id: 'middle' }];
  const edges = [
    { source: 'first', target: 'middle' },
    { source: 'middle', target: 'last' },
  ];
  assert.deepEqual(topologicalOrder(nodes, edges).map((node) => node.id), ['first', 'middle', 'last']);
});

test('topological order rejects cycles', () => {
  assert.throws(() => topologicalOrder(
    [{ id: 'a' }, { id: 'b' }],
    [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
  ), /cycle/i);
});

test('workflow executes the five-node chain and accepts an uploaded image at remover', async () => {
  const order = [];
  const result = await executeWorkflow({
    nodes: DEFAULT_NODES,
    edges: DEFAULT_EDGES,
    prompt: 'A red handbag',
    image: 'uploaded-image',
    adapters: {
      brain: async (prompt) => { order.push('brain'); return `Enhanced ${prompt}`; },
      flux: async () => { order.push('flux'); return 'generated-image'; },
      remover: async (image) => { order.push('remover'); return `transparent:${image}`; },
      upscaler: async (image) => { order.push('upscaler'); return `upscaled:${image}`; },
    },
  });
  assert.deepEqual(order, ['brain', 'remover', 'upscaler']);
  assert.equal(result.beforeRemoval, 'uploaded-image');
  assert.equal(result.afterRemoval, 'transparent:uploaded-image');
  assert.equal(result.beforeUpscale, 'transparent:uploaded-image');
  assert.equal(result.image, 'upscaled:transparent:uploaded-image');
  assert.match(result.html, /upscaled:transparent:uploaded-image/);
});

test('SQLite storage persists owners across connections and isolates access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fraymus-storage-'));
  const databasePath = join(directory, 'workflow.sqlite');
  try {
    let store = new WorkflowStore({ databasePath });
    await store.ensureUser({ id: 'user-a', email: 'a@example.test' });
    await store.ensureUser({ id: 'user-b', email: 'b@example.test' });
    const workflow = await store.createWorkflow({
      userId: 'user-a',
      name: 'Private chain',
      nodes: DEFAULT_NODES,
      edges: DEFAULT_EDGES,
    });
    store.close();

    store = new WorkflowStore({ databasePath });
    assert.equal((await store.getWorkflow(workflow.id, 'user-a')).name, 'Private chain');
    assert.equal(await store.getWorkflow(workflow.id, 'user-b'), null);
    assert.equal((await store.listWorkflows('user-b')).length, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
