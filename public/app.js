const $ = (selector) => document.querySelector(selector);
const canvas = $('#canvas');
const nodesLayer = $('#nodesLayer');
const edgeLayer = $('#edgeLayer');
const fileInput = $('#imageFile');
const authDialog = $('#authDialog');

const definitions = {
  llama: { label: 'Llama Brain', kind: 'PROMPT · GROQ', icon: '✦', tone: 'llama', detail: 'System prompt shapes your product image.' },
  flux: { label: 'FLUX Schnell', kind: 'IMAGE · HUGGING FACE', icon: '◈', tone: 'flux', detail: 'Fast, free text-to-image generation.' },
  remover: { label: 'Background Remover', kind: 'MASK · BIREFNET', icon: '◌', tone: 'remover', detail: 'Local AI cutout with transparent PNG.' },
  upscaler: { label: '4× Upscaler', kind: 'DETAIL · REAL-ESRGAN', icon: '↗', tone: 'upscaler', detail: 'AI upscale or Sharp Lanczos fallback.' },
  preview: { label: 'HTML Preview + API', kind: 'OUTPUT · DEPLOY', icon: '▣', tone: 'preview', detail: 'Preview the final image and deploy.' },
};

const initialNodes = [
  { id: 'brain', type: 'llama', label: definitions.llama.label, data: { systemPrompt: 'Write a concise, vivid product-image prompt. Return only the image prompt.' } },
  { id: 'flux', type: 'flux', label: definitions.flux.label, data: {} },
  { id: 'remover', type: 'remover', label: definitions.remover.label, data: {} },
  { id: 'upscaler', type: 'upscaler', label: definitions.upscaler.label, data: {} },
  { id: 'preview', type: 'preview', label: definitions.preview.label, data: {} },
];

const state = {
  token: localStorage.getItem('fraymus_access_token'),
  config: null,
  workflow: null,
  nodes: [],
  edges: [],
  selected: null,
  image: null,
  imageName: '',
  result: null,
  suggestion: null,
  authMode: 'signin',
  dirty: false,
};

let toastTimeout;
let suggestionTimeout;

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove('visible'), 3200);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const configuredUrl = document.querySelector('meta[name="workflow-api-url"]')?.content.trim()
    || state.config?.apiBaseUrl
    || '';
  let baseUrl = '';
  if (configuredUrl) {
    const parsedUrl = new URL(configuredUrl, window.location.origin);
    const localHttp = parsedUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !localHttp) {
      throw new Error('Workflow API URL must use HTTPS');
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
      throw new Error('Workflow API URL must be an origin without credentials or a path');
    }
    baseUrl = parsedUrl.origin;
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function setDirty() {
  state.dirty = true;
  $('#savedState').textContent = 'Unsaved changes';
  $('#savedState').style.color = '#e6bb75';
}

function setSaved() {
  state.dirty = false;
  $('#savedState').textContent = 'All changes saved';
  $('#savedState').style.color = '';
}

function createEdges(nodes) {
  return nodes.slice(1).map((node, index) => ({
    id: `edge-${index}`,
    source: nodes[index].id,
    target: node.id,
  }));
}

function updateNodePositions() {
  state.nodes.forEach((node, index) => {
    node.position = { x: 30 + index * 228, y: 80 };
  });
  state.edges = createEdges(state.nodes);
}

function renderEdges() {
  edgeLayer.replaceChildren();
  const canvasRect = canvas.getBoundingClientRect();
  for (let index = 0; index < state.nodes.length - 1; index += 1) {
    const from = document.getElementById(`node-${CSS.escape(state.nodes[index].id)}`);
    const to = document.getElementById(`node-${CSS.escape(state.nodes[index + 1].id)}`);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const line = document.createElement('div');
    line.className = 'edge-line';
    line.style.left = `${a.right - canvasRect.left}px`;
    line.style.top = `${a.top - canvasRect.top + a.height / 2}px`;
    line.style.width = `${Math.max(8, b.left - a.right)}px`;
    edgeLayer.append(line);
  }
}

function renderNodes() {
  nodesLayer.replaceChildren();
  nodesLayer.style.width = `${Math.max(canvas.clientWidth, state.nodes.length * 228 + 60)}px`;
  state.nodes.forEach((node, index) => {
    const definition = definitions[node.type];
    if (!definition) return;
    const card = document.createElement('article');
    card.id = `node-${node.id}`;
    card.className = `node-card ${definition.tone}${state.selected === node.id ? ' selected' : ''}`;
    card.draggable = true;
    card.style.position = 'absolute';
    card.style.left = `${30 + index * 228}px`;
    card.style.top = '80px';
    card.dataset.nodeId = node.id;
    if (index > 0) card.insertAdjacentHTML('beforeend', '<span class="node-port in"></span>');
    if (index < state.nodes.length - 1) card.insertAdjacentHTML('beforeend', '<span class="node-port out"></span>');

    const top = document.createElement('div');
    top.className = 'node-top';
    top.innerHTML = `<span class="node-icon">${definition.icon}</span><span class="node-kind">${definition.kind}</span>`;
    const removeButton = document.createElement('button');
    removeButton.className = 'node-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = 'Remove node';
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      state.nodes = state.nodes.filter((item) => item.id !== node.id);
      state.selected = null;
      updateNodePositions();
      renderNodes();
      setDirty();
      suggest();
    });
    top.append(removeButton);
    card.append(top);
    const title = document.createElement('strong');
    title.textContent = node.label || definition.label;
    card.append(title);
    const detail = document.createElement('small');
    detail.textContent = definition.detail;
    card.append(detail);

    if (node.type === 'llama' && state.selected === node.id) {
      const prompt = document.createElement('textarea');
      prompt.className = 'node-prompt';
      prompt.rows = 3;
      prompt.setAttribute('aria-label', 'Llama system prompt');
      prompt.value = node.data?.systemPrompt || '';
      prompt.addEventListener('click', (event) => event.stopPropagation());
      prompt.addEventListener('input', () => {
        node.data = { ...node.data, systemPrompt: prompt.value };
        setDirty();
      });
      card.append(prompt);
    }

    card.addEventListener('click', () => {
      state.selected = node.id;
      renderNodes();
    });
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', node.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData('text/plain');
      const fromIndex = state.nodes.findIndex((item) => item.id === draggedId);
      const toIndex = state.nodes.findIndex((item) => item.id === node.id);
      if (fromIndex < 0 || fromIndex === toIndex) return;
      const [moved] = state.nodes.splice(fromIndex, 1);
      state.nodes.splice(toIndex, 0, moved);
      updateNodePositions();
      renderNodes();
      setDirty();
      suggest();
    });
    nodesLayer.append(card);
  });
  $('#nodeCount').textContent = `${state.nodes.length} NODES`;
  renderEdges();
}

function renderWorkflowList(workflows) {
  const list = $('#workflowList');
  list.replaceChildren();
  for (const workflow of workflows) {
    const button = document.createElement('button');
    button.className = `workflow-item${workflow.id === state.workflow?.id ? ' active' : ''}`;
    button.innerHTML = '<span>◫</span>';
    const title = document.createElement('span');
    title.textContent = workflow.name;
    button.append(title);
    button.addEventListener('click', () => loadWorkflow(workflow));
    list.append(button);
  }
}

async function refreshWorkflows() {
  const { workflows } = await request('/api/workflows');
  renderWorkflowList(workflows);
  return workflows;
}

async function loadWorkflow(workflow) {
  state.workflow = workflow;
  state.nodes = structuredClone(workflow.nodes);
  state.edges = structuredClone(workflow.edges);
  state.selected = null;
  state.image = null;
  state.imageName = '';
  state.result = null;
  $('#workflowName').textContent = workflow.name;
  $('#uploadName').textContent = 'Drop an image here to send it to the remover';
  $('#clearUpload').hidden = true;
  updateNodePositions();
  renderNodes();
  renderWorkflowList(await request('/api/workflows').then((result) => result.workflows));
  setSaved();
  $('#comparisonMode').disabled = true;
  $('#comparisonMode').value = 'final';
  renderComparison();
  suggest();
}

async function newWorkflow() {
  const { workflow } = await request('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: 'Product Image Chain', nodes: initialNodes, edges: createEdges(initialNodes) }),
  });
  await loadWorkflow(workflow);
  toast('New workflow created');
}

async function saveWorkflow() {
  if (!state.workflow) return;
  $('#saveButton').disabled = true;
  try {
    const { workflow } = await request(`/api/workflows/${state.workflow.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('#workflowName').textContent,
        nodes: state.nodes,
        edges: state.edges,
      }),
    });
    state.workflow = workflow;
    setSaved();
    await refreshWorkflows();
    toast('Workflow saved');
  } finally {
    $('#saveButton').disabled = false;
  }
}

function addSuggestionNode() {
  const suggestion = state.suggestion || { type: 'llama', label: definitions.llama.label };
  if (!definitions[suggestion.type] || state.nodes.some((node) => node.type === suggestion.type)) {
    toast('That node is already on the canvas');
    return;
  }
  state.nodes.push({
    id: `${suggestion.type}-${crypto.randomUUID().slice(0, 8)}`,
    type: suggestion.type,
    label: definitions[suggestion.type].label,
    data: suggestion.type === 'llama'
      ? { systemPrompt: 'Write a concise, vivid product-image prompt. Return only the image prompt.' }
      : {},
  });
  updateNodePositions();
  renderNodes();
  setDirty();
  suggest();
}

async function suggest() {
  clearTimeout(suggestionTimeout);
  suggestionTimeout = setTimeout(async () => {
    try {
      const { suggestion } = await request('/api/rea/suggest', {
        method: 'POST',
        body: JSON.stringify({ nodes: state.nodes, edges: state.edges }),
      });
      state.suggestion = suggestion;
      $('#reaTitle').textContent = `REA: ${suggestion.label}`;
      $('#reaReason').textContent = suggestion.reason;
      $('#addNodeButton').textContent = `＋ ${suggestion.label}`;
    } catch {
      $('#reaTitle').textContent = 'REA unavailable';
      $('#reaReason').textContent = 'Try again after the server reconnects';
    }
  }, 250);
}

function addLog(label, status = 'done', time = 'Done') {
  const item = document.createElement('div');
  item.className = 'log-item';
  item.innerHTML = `<span class="log-dot ${status}"></span>`;
  const text = document.createElement('span');
  text.textContent = label;
  const timestamp = document.createElement('time');
  timestamp.textContent = time;
  item.append(text, timestamp);
  $('#logList').prepend(item);
}

function renderComparison() {
  const container = $('#preview');
  const mode = $('#comparisonMode').value;
  const comparisons = state.result?.comparisons || {};
  const before = mode === 'remover' ? comparisons.beforeRemoval : comparisons.beforeUpscale;
  const after = mode === 'remover' ? (comparisons.afterRemoval || comparisons.beforeUpscale) : state.result?.image;
  container.replaceChildren();
  if (!state.result?.image) {
    const empty = document.createElement('div');
    empty.className = 'preview-placeholder';
    empty.innerHTML = '<span>✦</span><strong>Your output appears here</strong><small>Run the workflow to see the result</small>';
    container.append(empty);
    return;
  }
  if (mode !== 'final' && before && after) {
    const wrap = document.createElement('div');
    wrap.className = 'comparison-wrap';
    const afterImage = document.createElement('img');
    afterImage.src = after;
    afterImage.alt = 'After processing';
    const beforeImage = document.createElement('img');
    beforeImage.src = before;
    beforeImage.alt = 'Before processing';
    beforeImage.className = 'comparison-before';
    wrap.append(afterImage, beforeImage);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '50';
    slider.className = 'compare-slider';
    slider.setAttribute('aria-label', 'Before and after comparison');
    slider.addEventListener('input', () => { beforeImage.style.width = `${slider.value}%`; });
    container.append(wrap, slider);
    beforeImage.style.width = '50%';
  } else {
    const image = document.createElement('img');
    image.src = state.result.image;
    image.alt = 'Final generated workflow output';
    image.className = 'result-image';
    container.append(image);
  }
  const details = document.createElement('details');
  details.className = 'html-output';
  const summary = document.createElement('summary');
  summary.textContent = 'View HTML output';
  const pre = document.createElement('pre');
  pre.textContent = state.result.html || '';
  details.append(summary, pre);
  container.append(details);
}

async function runWorkflow() {
  if (!state.workflow) return toast('Create a workflow first', true);
  $('#runButton').disabled = true;
  $('#runStatus').textContent = 'Running workflow nodes…';
  $('#runBadge').textContent = 'RUNNING';
  $('#runBadge').className = 'status-badge';
  $('#logList').replaceChildren();
  state.nodes.forEach((node) => addLog(definitions[node.type].label, 'active', 'Running'));
  try {
    const result = await request(`/api/workflows/${state.workflow.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ prompt: $('#prompt').value, ...(state.image ? { image: state.image } : {}) }),
    });
    state.result = result;
    $('#runStatus').textContent = `Completed in ${result.durationMs ? `${result.durationMs} ms` : 'a moment'}`;
    $('#runBadge').textContent = 'COMPLETE';
    $('#runBadge').className = 'status-badge success';
    $('#comparisonMode').disabled = false;
    renderComparison();
    $('#logList').replaceChildren();
    state.nodes.forEach((node) => addLog(definitions[node.type].label, 'done', 'Complete'));
    toast('Workflow completed');
  } catch (error) {
    $('#runStatus').textContent = error.message;
    $('#runBadge').textContent = 'ERROR';
    $('#runBadge').className = 'status-badge error';
    addLog(error.message, 'error', 'Failed');
    toast(error.message, true);
  } finally {
    $('#runButton').disabled = false;
  }
}

async function deployWorkflow() {
  if (!state.workflow) return;
  if (state.dirty) await saveWorkflow();
  $('#deployButton').disabled = true;
  try {
    const deployment = await request(`/api/workflows/${state.workflow.id}/deploy`, { method: 'POST', body: '{}' });
    $('#deployCode').hidden = false;
    $('#curlCode').textContent = deployment.curl;
    toast('Workflow API deployed. Store this API key somewhere safe.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    $('#deployButton').disabled = false;
  }
}

async function readUpload(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    toast('Choose a PNG, JPEG, or WebP image', true);
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast('Images must be smaller than 8 MB', true);
    return;
  }
  state.image = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected image'));
    reader.readAsDataURL(file);
  });
  state.imageName = file.name;
  $('#uploadName').textContent = `${file.name} · will be sent to Background Remover`;
  $('#clearUpload').hidden = false;
}

function showAuthDialog() {
  authDialog.showModal();
}

async function initAuth() {
  state.config = await request('/api/config');
  $('#billingButton').hidden = !state.config.authEnabled;
  if (!state.config.authEnabled) {
    $('#accountButton').addEventListener('click', () => toast('Local development workspace · configure Supabase Auth for accounts'));
    return;
  }
  $('#accountButton').addEventListener('click', showAuthDialog);
  $('#accountLabel').textContent = state.token ? 'Signed in' : 'Sign in';
  if (!state.token) showAuthDialog();
}

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#authMessage');
  message.textContent = '';
  try {
    const endpoint = state.authMode === 'signup' ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    const response = await fetch(`${state.config.supabaseUrl}${endpoint}`, {
      method: 'POST',
      headers: { apikey: state.config.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#authEmail').value, password: $('#authPassword').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.msg || data.message || data.error_description || 'Could not authenticate');
    if (!data.access_token) {
      message.textContent = 'Check your email to confirm your account, then sign in.';
      return;
    }
    state.token = data.access_token;
    localStorage.setItem('fraymus_access_token', state.token);
    $('#accountLabel').textContent = data.user?.email || 'Signed in';
    authDialog.close();
    await initializeWorkflows();
  } catch (error) {
    message.textContent = error.message;
  }
});

$('#toggleAuthMode').addEventListener('click', () => {
  state.authMode = state.authMode === 'signin' ? 'signup' : 'signin';
  $('#authTitle').textContent = state.authMode === 'signup' ? 'Create your account' : 'Sign in to Fraymus';
  $('#authSubmit').textContent = state.authMode === 'signup' ? 'Create account' : 'Sign in';
  $('#toggleAuthMode').textContent = state.authMode === 'signup' ? 'I already have an account' : 'Create an account instead';
  $('#authMessage').textContent = '';
});

async function initializeWorkflows() {
  try {
    const workflows = await refreshWorkflows();
    if (workflows.length) await loadWorkflow(workflows[0]);
    else await newWorkflow();
  } catch (error) {
    if (error.message.includes('Sign in')) showAuthDialog();
    else toast(error.message, true);
  }
}

$('#newWorkflow').addEventListener('click', () => newWorkflow().catch((error) => toast(error.message, true)));
$('#saveButton').addEventListener('click', () => saveWorkflow().catch((error) => toast(error.message, true)));
$('#runButton').addEventListener('click', runWorkflow);
$('#deployButton').addEventListener('click', () => deployWorkflow().catch((error) => toast(error.message, true)));
$('#billingButton').addEventListener('click', async () => {
  try {
    const { url } = await request('/api/billing/checkout', { method: 'POST', body: '{}' });
    window.location.assign(url);
  } catch (error) {
    toast(error.message, true);
  }
});
$('#addNodeButton').addEventListener('click', addSuggestionNode);
$('#uploadButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => readUpload(fileInput.files?.[0]).catch((error) => toast(error.message, true)));
$('#clearUpload').addEventListener('click', () => {
  state.image = null;
  state.imageName = '';
  fileInput.value = '';
  $('#uploadName').textContent = 'Drop an image here to send it to the remover';
  $('#clearUpload').hidden = true;
});
$('#comparisonMode').addEventListener('change', renderComparison);
$('#fitButton').addEventListener('click', () => { canvas.scrollTo({ left: 0, behavior: 'smooth' }); });
$('#copyCurl').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#curlCode').textContent);
  toast('cURL command copied');
});
canvas.addEventListener('dragover', (event) => {
  if ([...event.dataTransfer.types].includes('Files')) {
    event.preventDefault();
    canvas.classList.add('dragging');
  }
});
canvas.addEventListener('dragleave', (event) => {
  if (!canvas.contains(event.relatedTarget)) canvas.classList.remove('dragging');
});
canvas.addEventListener('drop', (event) => {
  if (event.dataTransfer.files?.length) {
    event.preventDefault();
    canvas.classList.remove('dragging');
    readUpload(event.dataTransfer.files[0]).catch((error) => toast(error.message, true));
  }
});
canvas.addEventListener('scroll', renderEdges);
window.addEventListener('resize', renderEdges);
window.addEventListener('beforeunload', (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

initAuth().then(initializeWorkflows).catch((error) => toast(error.message, true));
if (new URLSearchParams(location.search).get('billing') === 'success') {
  toast('Checkout completed. Metered usage will be billed to your account.');
}
