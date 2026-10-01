import { toCanvas } from 'html-to-image';

export type Bounds = { x: number; y: number; width: number; height: number };

export async function captureSelection(bounds: Bounds, ordinal: number): Promise<File> {
  const surface = document.querySelector<HTMLElement>('.app-layout');
  if (!surface) throw new Error('The visible Mandible workspace is unavailable for capture.');
  const outer = surface.getBoundingClientRect();
  const scale = devicePixelRatio || 1;
  const canvas = await toCanvas(surface, {
    pixelRatio: scale,
    cacheBust: false,
    filter: node => !(node instanceof Element && node.hasAttribute('data-annotator-ui')),
  });
  const sx = Math.max(0, Math.round((bounds.x - outer.left) * scale));
  const sy = Math.max(0, Math.round((bounds.y - outer.top) * scale));
  const width = Math.min(canvas.width - sx, Math.round(bounds.width * scale));
  const height = Math.min(canvas.height - sy, Math.round(bounds.height * scale));
  if (width <= 0 || height <= 0) throw new Error('The selected area is outside the visible workspace.');
  const cropped = document.createElement('canvas');
  cropped.width = width;
  cropped.height = height;
  const context = cropped.getContext('2d');
  if (!context) throw new Error('Image capture is unavailable in this browser.');
  context.drawImage(canvas, sx, sy, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => cropped.toBlob(resolve, 'image/png'));
  if (!blob || blob.size === 0) throw new Error('The selected area could not be captured.');
  return new File([blob], `annotation-${ordinal}.png`, { type: 'image/png' });
}
