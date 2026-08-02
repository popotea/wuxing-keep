import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjsPkg from 'pngjs';

const { PNG } = pngjsPkg;
const ROOT = path.resolve(import.meta.dirname, '..');
const GENERATED = 'C:\\Users\\ching\\.codex\\generated_images\\019fc2de-f671-7702-b4ba-38bcde53d8e4';
const SIZE = 256;

const towers = {
  metal: 'exec-3eb41564-2198-4c7d-8da5-d73bf23cf1a6.png',
  'metal-burst': 'exec-e469544e-538e-4cd1-937f-f41ce9668695.png',
  'metal-splash': 'exec-002dbf7d-6600-4369-89c6-cad6d75913aa.png',
  wood: 'exec-d0671540-b3d3-4781-85b3-ad8df455382d.png',
  'wood-burst': 'exec-74910030-ab5f-4d50-960f-707a77aceeba.png',
  'wood-splash': 'exec-8fe4adfc-f20d-4b20-a9e0-cb795d05ab95.png',
  earth: 'exec-2779c543-d4d4-49d8-99d2-a43490ff2f1e.png',
  'earth-burst': 'exec-0f10da1c-8423-465d-9286-3851a0a95397.png',
  'earth-splash': 'exec-ef4eaf2f-e372-42f3-9c98-87ec8b86e441.png',
  water: 'exec-aff53b7e-31a5-4c44-bfff-d8821fe8f770.png',
  'water-burst': 'exec-900a5352-ad5c-480f-9d00-5a438823c5b1.png',
  'water-splash': 'exec-f1d83f90-d89a-4321-9660-f308fdb0d0d4.png',
  fire: 'exec-1fae3615-6b00-475f-ab5d-6dc2a183f754.png',
  'fire-burst': 'exec-c3726797-7354-49cc-8c33-52b02a9a53d1.png',
  'fire-splash': 'exec-9475dde2-998d-474b-8ff2-53ad6ecf4622.png',
};

const tiles = {
  'crossroads/floor': 'exec-78bd8fc7-eabc-4e1c-b9ba-7431c727c3c5.png',
  'crossroads/path': 'exec-cd854b66-187f-481b-8228-d049f91e6c81.png',
  'serpent/floor': 'exec-9aed3032-688c-460a-bf23-7299da4919e5.png',
  'serpent/path': 'exec-0a68d448-b98d-4122-991b-f8549737c8ba.png',
  'trident/floor': 'exec-350cf6eb-3da2-493f-888a-4109a9cd7f3b.png',
  'trident/path': 'exec-380d4dac-bb18-49d6-b5f4-d49e7cebf7ff.png',
  'quad/floor': 'exec-eecf8c9f-d0a3-47d7-a2e9-072eaf47c44b.png',
  'quad/path': 'exec-e3f364cf-ad3f-444b-a74b-c6d0d39dff04.png',
};

const clamp = (value, min = 0, max = 255) => Math.max(min, Math.min(max, value));

function keyDistance(data, index) {
  const dr = data[index] - 255;
  const dg = data[index + 1];
  const db = data[index + 2] - 255;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function removeConnectedChroma(png) {
  const { width, height, data } = png;

  // Image generation keeps the requested magenta hue but introduces small
  // brightness variations and disconnected paint flecks. Remove by hue rather
  // than exact RGB or border connectivity; prompts explicitly forbid magenta
  // inside the tower itself.
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const magentaLike = red > 80 && blue > 80 && green < Math.max(red, blue) * 0.58 && Math.abs(red - blue) < 95;
    if (magentaLike || keyDistance(data, offset) < 72) data[offset + 3] = 0;
  }

  // Clear isolated generation noise while preserving substantial detached
  // pieces such as the Earth splash tower's floating stones.
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  for (let seed = 0; seed < width * height; seed++) {
    if (visited[seed] || data[seed * 4 + 3] < 20) continue;
    let head = 0;
    let tail = 0;
    visited[seed] = 1;
    queue[tail++] = seed;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const visit = (next) => {
        if (visited[next] || data[next * 4 + 3] < 20) return;
        visited[next] = 1;
        queue[tail++] = next;
      };
      if (x > 0) visit(pixel - 1);
      if (x + 1 < width) visit(pixel + 1);
      if (y > 0) visit(pixel - width);
      if (y + 1 < height) visit(pixel + width);
    }
    if (tail < 180) {
      for (let i = 0; i < tail; i++) data[queue[i] * 4 + 3] = 0;
    }
  }

  return png;
}

function boundsForAlpha(png, minimumAlpha = 20) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] < minimumAlpha) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error('No opaque subject found after chroma removal.');
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function sampleBilinear(png, x, y) {
  const x0 = clamp(Math.floor(x), 0, png.width - 1);
  const y0 = clamp(Math.floor(y), 0, png.height - 1);
  const x1 = Math.min(x0 + 1, png.width - 1);
  const y1 = Math.min(y0 + 1, png.height - 1);
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const weights = [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]];
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const [sx, sy, weight] of weights) {
    const index = (sy * png.width + sx) * 4;
    const a = png.data[index + 3] / 255;
    alpha += a * weight;
    red += png.data[index] * a * weight;
    green += png.data[index + 1] * a * weight;
    blue += png.data[index + 2] * a * weight;
  }
  if (alpha <= 0.0001) return [0, 0, 0, 0];
  return [Math.round(red / alpha), Math.round(green / alpha), Math.round(blue / alpha), Math.round(alpha * 255)];
}

function normalizeTower(png) {
  const bounds = boundsForAlpha(png);
  const scale = Math.min(218 / bounds.width, 224 / bounds.height);
  const drawWidth = bounds.width * scale;
  const drawHeight = bounds.height * scale;
  const left = (SIZE - drawWidth) / 2;
  const top = 244 - drawHeight;
  const output = new PNG({ width: SIZE, height: SIZE, colorType: 6 });
  output.data.fill(0);

  for (let y = Math.max(0, Math.floor(top)); y < Math.min(SIZE, Math.ceil(top + drawHeight)); y++) {
    for (let x = Math.max(0, Math.floor(left)); x < Math.min(SIZE, Math.ceil(left + drawWidth)); x++) {
      const sourceX = bounds.minX + (x + 0.5 - left) / scale - 0.5;
      const sourceY = bounds.minY + (y + 0.5 - top) / scale - 0.5;
      const color = sampleBilinear(png, sourceX, sourceY);
      const index = (y * SIZE + x) * 4;
      output.data[index] = color[0];
      output.data[index + 1] = color[1];
      output.data[index + 2] = color[2];
      output.data[index + 3] = color[3];
    }
  }
  return output;
}

function resizeOpaque(png) {
  const output = new PNG({ width: SIZE, height: SIZE, colorType: 6 });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const color = sampleBilinear(png, (x + 0.5) * png.width / SIZE - 0.5, (y + 0.5) * png.height / SIZE - 0.5);
      const index = (y * SIZE + x) * 4;
      output.data[index] = color[0];
      output.data[index + 1] = color[1];
      output.data[index + 2] = color[2];
      output.data[index + 3] = 255;
    }
  }
  return output;
}

function blendOppositeEdges(png, band = 36) {
  const { width, height, data } = png;
  for (let offset = 0; offset < band; offset++) {
    const weight = 1 - offset / band;
    for (let y = 0; y < height; y++) {
      const left = (y * width + offset) * 4;
      const right = (y * width + width - 1 - offset) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const average = (data[left + channel] + data[right + channel]) / 2;
        data[left + channel] = Math.round(data[left + channel] * (1 - weight) + average * weight);
        data[right + channel] = Math.round(data[right + channel] * (1 - weight) + average * weight);
      }
    }
  }
  for (let offset = 0; offset < band; offset++) {
    const weight = 1 - offset / band;
    for (let x = 0; x < width; x++) {
      const top = (offset * width + x) * 4;
      const bottom = ((height - 1 - offset) * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const average = (data[top + channel] + data[bottom + channel]) / 2;
        data[top + channel] = Math.round(data[top + channel] * (1 - weight) + average * weight);
        data[bottom + channel] = Math.round(data[bottom + channel] * (1 - weight) + average * weight);
      }
    }
  }
  return png;
}

async function readPng(filename) {
  return PNG.sync.read(await readFile(path.join(GENERATED, filename)));
}

async function savePng(filename, png) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, PNG.sync.write(png));
}

for (const [name, filename] of Object.entries(towers)) {
  const source = removeConnectedChroma(await readPng(filename));
  const output = normalizeTower(source);
  await savePng(path.join(ROOT, 'public', 'assets', 'towers-v2', `${name}.png`), output);
  console.log(`tower ${name}: ${source.width}x${source.height} -> ${SIZE}x${SIZE}`);
}

for (const [name, filename] of Object.entries(tiles)) {
  const source = await readPng(filename);
  const output = blendOppositeEdges(resizeOpaque(source));
  await savePng(path.join(ROOT, 'public', 'assets', 'tiles-v2', `${name}.png`), output);
  console.log(`tile ${name}: ${source.width}x${source.height} -> ${SIZE}x${SIZE}`);
}
