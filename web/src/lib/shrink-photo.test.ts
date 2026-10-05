import { shrinkPhoto } from './shrink-photo';

const original = () => new Blob([new Uint8Array(10)], { type: 'image/jpeg' });

describe('shrinkPhoto', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reduces a 4000x3000 photo to fit within 1600px on its longest side, applying the EXIF orientation', async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn().mockResolvedValue({ width: 4000, height: 3000, close });
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const drawImage = vi.fn();
    const reduced = new Blob([new Uint8Array(5)], { type: 'image/jpeg' });
    let capturedCanvas: HTMLCanvasElement | null = null;
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === 'canvas') capturedCanvas = el as HTMLCanvasElement;
      return el;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(reduced);
    });

    const file = original();
    const result = await shrinkPhoto(file);

    expect(result).toBe(reduced);
    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(capturedCanvas!.width).toBe(1600);
    expect(capturedCanvas!.height).toBe(1200);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 1200);
    expect(close).toHaveBeenCalled();
  });

  it('uses the bitmap\'s already-oriented dimensions for a portrait photo (3000x4000 -> 1200x1600)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 3000, height: 4000, close: vi.fn() }));
    const drawImage = vi.fn();
    const reduced = new Blob([new Uint8Array(5)], { type: 'image/jpeg' });
    let capturedCanvas: HTMLCanvasElement | null = null;
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === 'canvas') capturedCanvas = el as HTMLCanvasElement;
      return el;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(reduced);
    });

    const result = await shrinkPhoto(original());

    expect(result).toBe(reduced);
    expect(capturedCanvas!.width).toBe(1200);
    expect(capturedCanvas!.height).toBe(1600);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1200, 1600);
  });

  it('falls back to the original file when createImageBitmap throws on the orientation option', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('options non supportées')));
    const file = original();

    const result = await shrinkPhoto(file);

    expect(result).toBe(file);
  });

  it('never upscales a photo already within the limit', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 800, height: 600, close: vi.fn() }));
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');

    const file = original();
    const result = await shrinkPhoto(file);

    expect(result).toBe(file);
    expect(toBlob).not.toHaveBeenCalled();
  });

  it('falls back to the original file when createImageBitmap is missing', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const file = original();

    const result = await shrinkPhoto(file);

    expect(result).toBe(file);
  });

  it('falls back to the original file when createImageBitmap throws', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('format non lisible')));
    const file = original();

    const result = await shrinkPhoto(file);

    expect(result).toBe(file);
  });

  it('falls back to the original file when the canvas has no 2d context', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const file = original();

    const result = await shrinkPhoto(file);

    expect(result).toBe(file);
  });

  it('falls back to the original file when toBlob yields nothing', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(null);
    });
    const file = original();

    const result = await shrinkPhoto(file);

    expect(result).toBe(file);
  });
});
