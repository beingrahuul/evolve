// Save files are gzip-compressed JSON. These helpers work on any thread (the simulation worker too).
import { deserializeWorld, serializeWorld } from './serialize';
import type { World } from './world';

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
