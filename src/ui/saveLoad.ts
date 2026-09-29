import { SaveMeta, deserializeWorld, serializeWorld } from '../sim/serialize';
import type { World } from '../sim/world';

// Save files are gzip-compressed JSON. The quick-save slot lives in IndexedDB.

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzipToText(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text(); // plain JSON
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function worldToBlob(w: World): Promise<Blob> {
  return gzip(JSON.stringify(serializeWorld(w)));
}

export async function blobToWorld(blob: Blob): Promise<World> {
  const text = await gunzipToText(blob);
  return deserializeWorld(JSON.parse(text));
}

export async function downloadWorld(w: World) {
  const blob = await worldToBlob(w);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `primordial-seed${w.seed}-day${w.days + 1}.primordial`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return blob.size;
}

export function pickWorldFile(): Promise<World | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.primordial,.json,.gz';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        resolve(await blobToWorld(f));
      } catch (e) {
        reject(e);
      }
    });
    input.click();
  });
}

// ---- quick save (IndexedDB) ----------------------------------------------------

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('primordial', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('saves');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function quickSave(w: World): Promise<SaveMeta> {
  const blob = await worldToBlob(w);
  const meta: SaveMeta = serializeMeta(w);
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('saves', 'readwrite');
    tx.objectStore('saves').put({ blob, meta }, 'quick');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return meta;
}

export async function quickLoad(): Promise<World | null> {
  const d = await db();
  const rec = await new Promise<{ blob: Blob; meta: SaveMeta } | undefined>((resolve, reject) => {
    const req = d.transaction('saves').objectStore('saves').get('quick');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return rec ? blobToWorld(rec.blob) : null;
}

export async function quickSaveMeta(): Promise<SaveMeta | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction('saves').objectStore('saves').get('quick');
      req.onsuccess = () => resolve(req.result?.meta ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

function serializeMeta(w: World): SaveMeta {
  return {
    version: 2,
    seed: w.seed,
    savedAt: new Date().toISOString(),
    day: w.days + 1,
    population: w.orgs.length,
    species: w.species.alive().length,
  };
}
