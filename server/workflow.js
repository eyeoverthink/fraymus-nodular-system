export const DEFAULT_NODES = [
  { id: 'brain', type: 'llama', label: 'Llama Brain', position: { x: 60, y: 170 }, data: { systemPrompt: 'Write a concise, vivid product-image prompt. Return only the image prompt.' } },
  { id: 'flux', type: 'flux', label: 'FLUX Schnell', position: { x: 300, y: 170 }, data: {} },
  { id: 'remover', type: 'remover', label: 'Background Remover', position: { x: 540, y: 170 }, data: {} },
  { id: 'upscaler', type: 'upscaler', label: '4× Upscaler', position: { x: 780, y: 170 }, data: {} },
  { id: 'preview', type: 'preview', label: 'HTML Preview + API', position: { x: 1020, y: 170 }, data: {} },
];

export const DEFAULT_EDGES = DEFAULT_NODES.slice(1).map((node, index) => ({
  id: `edge-${index}`,
  source: DEFAULT_NODES[index].id,
  target: node.id,
}));

export function topologicalOrder(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.set(edge.target, incoming.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }

  const ready = nodes.filter((node) => incoming.get(node.id) === 0);
  const ordered = [];
  while (ready.length) {
    const node = ready.shift();
    ordered.push(node);
    for (const target of outgoing.get(node.id)) {
      incoming.set(target, incoming.get(target) - 1);
      if (incoming.get(target) === 0) ready.push(byId.get(target));
    }
  }
  if (ordered.length !== nodes.length) throw new Error('Workflow contains a cycle');
  return ordered;
}

export async function executeWorkflow({ nodes, edges, prompt, image, adapters, onNode }) {
  const ordered = topologicalOrder(nodes, edges);
  let context = {
    prompt: String(prompt || 'A studio product photo'),
    image: image || null,
    beforeRemoval: image || null,
    afterRemoval: null,
    beforeUpscale: null,
    upscaled: false,
    html: '',
  };
  for (const node of ordered) {
    if (node.type === 'llama') {
      context.prompt = await adapters.brain(context.prompt, node.data?.systemPrompt || '');
    } else if (node.type === 'flux' && !image) {
      context.image = await adapters.flux(context.prompt);
    } else if (node.type === 'remover' && context.image) {
      context.beforeRemoval = context.image;
      context.image = await adapters.remover(context.image);
      context.afterRemoval = context.image;
    } else if (node.type === 'upscaler' && context.image) {
      context.beforeUpscale = context.image;
      context.image = await adapters.upscaler(context.image);
      context.upscaled = true;
    } else if (node.type === 'preview') {
      context.html = `<main><img src="${context.image || ''}" alt="Generated workflow result" style="max-width:100%;height:auto"></main>`;
    }
    await onNode?.({ id: node.id, type: node.type, output: node.type === 'preview' ? context.html : undefined });
  }
  return context;
}

export function suggestNextNode(nodes = []) {
  const types = new Set(nodes.map((node) => node.type));
  if (!types.has('llama')) return { type: 'llama', label: 'Add Llama Brain', reason: 'Shape the prompt before image generation.' };
  if (!types.has('flux')) return { type: 'flux', label: 'Add FLUX Schnell', reason: 'Generate an image from the prompt.' };
  if (!types.has('remover')) return { type: 'remover', label: 'Add Background Remover', reason: 'Create a transparent product cutout.' };
  if (!types.has('upscaler')) return { type: 'upscaler', label: 'Add 4× Upscaler', reason: 'Increase output resolution.' };
  if (!types.has('preview')) return { type: 'preview', label: 'Add HTML Preview', reason: 'Preview and deploy this workflow.' };
  return { type: 'preview', label: 'Workflow ready', reason: 'Your chain is ready to run and deploy.' };
}
