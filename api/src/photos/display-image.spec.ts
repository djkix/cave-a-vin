import { cropRect, grayWorldFactors, plausibleLabelBox } from './display-image';

describe('plausibleLabelBox', () => {
  it('accepte un cadre cohérent couvrant entre 5 % et 95 % de l’image', () => {
    expect(plausibleLabelBox([100, 200, 900, 800])).toBe(true);
    // 5 % exactement : 250 × 200 / 1 000 000
    expect(plausibleLabelBox([0, 0, 250, 200])).toBe(true);
    // 95 % exactement : 1000 × 950
    expect(plausibleLabelBox([0, 0, 1000, 950])).toBe(true);
  });

  it('refuse l’absence de cadre', () => {
    expect(plausibleLabelBox(null)).toBe(false);
  });

  it('refuse des coordonnées hors de 0..1000', () => {
    expect(plausibleLabelBox([-1, 100, 800, 800])).toBe(false);
    expect(plausibleLabelBox([100, 100, 1001, 800])).toBe(false);
  });

  it('refuse un cadre retourné ou plat', () => {
    expect(plausibleLabelBox([800, 100, 200, 900])).toBe(false);
    expect(plausibleLabelBox([100, 900, 800, 100])).toBe(false);
    expect(plausibleLabelBox([100, 100, 100, 900])).toBe(false);
  });

  it('refuse un cadre trop petit (< 5 %) ou trop grand (> 95 %)', () => {
    expect(plausibleLabelBox([0, 0, 249, 200])).toBe(false);
    expect(plausibleLabelBox([0, 0, 1000, 1000])).toBe(false);
  });

  it('refuse des valeurs non finies', () => {
    expect(plausibleLabelBox([Number.NaN, 0, 800, 800])).toBe(false);
    expect(plausibleLabelBox([0, 0, Number.POSITIVE_INFINITY, 800])).toBe(false);
  });
});

describe('cropRect', () => {
  it('convertit le cadre en pixels avec une marge de 8 % de la taille du cadre de chaque côté', () => {
    // Cadre : lignes 200..600 (400 px), colonnes 250..750 (500 px) sur 1000 × 800.
    expect(cropRect([250, 250, 750, 750], 1000, 800)).toEqual({ left: 210, top: 168, width: 580, height: 464 });
  });

  it('accepte une autre marge', () => {
    expect(cropRect([250, 250, 750, 750], 1000, 800, 0)).toEqual({ left: 250, top: 200, width: 500, height: 400 });
  });

  it('reste dans l’image quand la marge déborde', () => {
    expect(cropRect([0, 0, 1000, 1000], 640, 480)).toEqual({ left: 0, top: 0, width: 640, height: 480 });
    expect(cropRect([10, 950, 500, 1000], 1000, 1000)).toEqual({ left: 946, top: 0, width: 54, height: 540 });
  });

  it('rend toujours au moins un pixel', () => {
    const r = cropRect([500, 500, 500, 500], 3, 3, 0);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
    expect(r.left + r.width).toBeLessThanOrEqual(3);
    expect(r.top + r.height).toBeLessThanOrEqual(3);
  });
});

describe('grayWorldFactors', () => {
  it('ramène chaque canal à la moyenne des trois', () => {
    const [r, g, b] = grayWorldFactors([110, 100, 90]);
    expect(110 * r).toBeCloseTo(100);
    expect(100 * g).toBeCloseTo(100);
    expect(90 * b).toBeCloseTo(100);
  });

  it('ne touche pas une image déjà neutre', () => {
    expect(grayWorldFactors([120, 120, 120])).toEqual([1, 1, 1]);
  });

  it('borne les facteurs entre 0,8 et 1,25', () => {
    expect(grayWorldFactors([200, 50, 50])).toEqual([0.8, 1.25, 1.25]);
    expect(grayWorldFactors([0, 100, 200])).toEqual([1.25, 1, 0.8]);
  });

  it('laisse une image noire telle quelle', () => {
    expect(grayWorldFactors([0, 0, 0])).toEqual([1, 1, 1]);
  });
});
