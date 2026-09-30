import { SAVE_VERSION, SaveMeta } from '../sim/serialize';
import type { World } from '../sim/world';

// Save files are gzip-compressed JSON, made wherever the simulation runs (see sim/savefile.ts).
// Here: downloading and opening files, and the quick-save slot in IndexedDB.

export function downloadBlob(blob: Blob, w: World) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `primordial-seed${w.seed}-day${w.days + 1}.primordial`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pickFile(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.primordial,.json,.gz';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
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

export async function quickSave(blob: Blob, w: World): Promise<SaveMeta> {
  const meta: SaveMeta = {
    version: SAVE_VERSION,
    seed: w.seed,
    width: w.width,
    savedAt: new Date().toISOString(),
    day: w.days + 1,
    population: w.orgs.length,
    species: w.species.alive().length,
  };
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('saves', 'readwrite');
    tx.objectStore('saves').put({ blob, meta }, 'quick');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return meta;
}

export async function quickLoad(): Promise<Blob | null> {
  const d = await db();
  const rec = await new Promise<{ blob: Blob; meta: SaveMeta } | undefined>((resolve, reject) => {
    const req = d.transaction('saves').objectStore('saves').get('quick');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return rec ? rec.blob : null;
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
