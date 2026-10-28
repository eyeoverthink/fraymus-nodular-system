import { removeBackground } from '@imgly/background-removal-node';
import Replicate from 'replicate';
import sharp from 'sharp';

const FLUX_URL = 'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell';
const REMOVER_URL = 'https://router.huggingface.co/hf-inference/models/briaai/RMBG-1.4';

function decodeImage(image) {
  const match = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!match) throw new Error('Expected a base64-encoded image data URL');
  return Buffer.from(match[1], 'base64');
}

function imageData(buffer, mime = 'image/png') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function makePlaceholder(prompt) {
  const safe = String(prompt).replace(/[<>&"']/g, '').slice(0, 100);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#171522"/><circle cx="512" cy="450" r="220" fill="#6c5ce7" opacity=".75"/><text x="50%" y="82%" text-anchor="middle" fill="white" font-family="sans-serif" font-size="24">${safe}</text><text x="50%" y="90%" text-anchor="middle" fill="#aaa" font-family="sans-serif" font-size="16">FLUX mock — configure HF_TOKEN</text></svg>`;
  return imageData(Buffer.from(svg), 'image/svg+xml');
}

async function providerImage(url, input, token, contentType = 'application/json') {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': contentType,
      Accept: 'image/*',
    },
    body: contentType === 'application/json' ? JSON.stringify(input) : input,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Image provider returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || !response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error('Image provider returned an invalid image response');
  }
  return imageData(buffer, response.headers.get('content-type'));
}

export async function generateImage(prompt) {
  if (process.env.MOCK_AI === '1') return makePlaceholder(prompt);
  if (!process.env.HF_TOKEN) return makePlaceholder(prompt);
  return providerImage(
    FLUX_URL,
    { inputs: prompt, parameters: { num_inference_steps: 4 } },
    process.env.HF_TOKEN,
  );
}

export async function removeImageBackground(image) {
  if (process.env.MOCK_AI === '1') return image;
  const input = decodeImage(image);
  try {
    const result = await removeBackground(input, { model: 'small', output: { format: 'image/png' } });
    return imageData(Buffer.from(await result.arrayBuffer()));
  } catch (localError) {
    if (!process.env.HF_TOKEN) {
      console.warn(`Local background removal unavailable: ${localError.message}`);
      return imageData(await sharp(input, { limitInputPixels: 40_000_000 }).png().toBuffer());
    }
    return providerImage(REMOVER_URL, input, process.env.HF_TOKEN, 'image/png');
  }
}

export async function upscaleImage(image) {
  const input = decodeImage(image);
  const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not read input image dimensions');
  const width = Math.min(metadata.width * 4, 4096);
  const height = Math.min(metadata.height * 4, 4096);

  if (process.env.REPLICATE_API_TOKEN && process.env.MOCK_AI !== '1') {
    try {
      const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
      const result = await replicate.run('nightmareai/real-esrgan', {
        input: { image: input, scale: 4 },
      });
      const output = Array.isArray(result) ? result[0] : result;
      let resultBuffer;
      if (output && typeof output.blob === 'function') {
        resultBuffer = Buffer.from(await (await output.blob()).arrayBuffer());
      } else {
        const outputUrl = typeof output === 'string' ? output : output?.url?.();
        if (typeof outputUrl !== 'string' || !outputUrl.startsWith('https://')) {
          throw new Error('Real-ESRGAN returned an invalid output');
        }
        const response = await fetch(outputUrl, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Real-ESRGAN returned ${response.status}`);
        const size = Number(response.headers.get('content-length')) || 0;
        if (size > 50 * 1024 * 1024) throw new Error('Real-ESRGAN output is too large');
        resultBuffer = Buffer.from(await response.arrayBuffer());
      }
      if (resultBuffer.length > 50 * 1024 * 1024) throw new Error('Real-ESRGAN output is too large');
      return imageData(await sharp(resultBuffer, { limitInputPixels: 40_000_000 }).png().toBuffer());
    } catch (error) {
      console.warn(`Real-ESRGAN unavailable, using Sharp resize: ${error.message}`);
    }
  }

  const result = await sharp(input, { limitInputPixels: 40_000_000 })
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  return imageData(result);
}

export const imageBuffer = decodeImage;
export const imageDataUrl = imageData;
