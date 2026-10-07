import sharp from 'sharp';
import { LabelBox } from '../vision/vision-provider.interface';

/** Taille maximale (plus grand côté) de la version d'affichage. */
const DISPLAY_MAX_SIDE = 1200;
const MIN_AREA = 0.05;
const MAX_AREA = 0.95;
const MIN_FACTOR = 0.8;
const MAX_FACTOR = 1.25;

/**
 * Un cadre n'est utilisé pour recadrer que s'il est cohérent (coordonnées dans
 * 0..1000, ymin < ymax, xmin < xmax) et couvre entre 5 % et 95 % de la photo :
 * en dehors, mieux vaut garder la photo entière qu'un recadrage douteux.
 */
export function plausibleLabelBox(box: LabelBox | null | undefined): box is LabelBox {
  if (!box || box.length !== 4) return false;
  if (!box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000)) return false;
  const [ymin, xmin, ymax, xmax] = box;
  if (ymin >= ymax || xmin >= xmax) return false;
  const area = ((ymax - ymin) * (xmax - xmin)) / 1_000_000;
  return area >= MIN_AREA && area <= MAX_AREA;
}

/**
 * Rectangle de recadrage en pixels : le cadre élargi de `margin` (part de la
 * hauteur et de la largeur du cadre) de chaque côté, borné à l'image, d'au
 * moins un pixel.
 */
export function cropRect(
  box: LabelBox,
  width: number,
  height: number,
  margin = 0.08,
): { left: number; top: number; width: number; height: number } {
  const [ymin, xmin, ymax, xmax] = box;
  const my = (ymax - ymin) * margin;
  const mx = (xmax - xmin) * margin;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const left = clamp(Math.floor(((xmin - mx) / 1000) * width), width - 1);
  const top = clamp(Math.floor(((ymin - my) / 1000) * height), height - 1);
  const right = clamp(Math.ceil(((xmax + mx) / 1000) * width), width);
  const bottom = clamp(Math.ceil(((ymax + my) / 1000) * height), height);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * Balance des blancs « monde gris » : chaque canal est multiplié pour ramener
 * sa moyenne à la moyenne des trois, facteur borné entre 0,8 et 1,25 pour ne
 * jamais dénaturer une étiquette réellement colorée.
 */
export function grayWorldFactors(means: [number, number, number]): [number, number, number] {
  const gray = (means[0] + means[1] + means[2]) / 3;
  if (!(gray > 0)) return [1, 1, 1];
  const factor = (m: number) => (m > 0 ? Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, gray / m)) : MAX_FACTOR);
  return [factor(means[0]), factor(means[1]), factor(means[2])];
}

/**
 * Version d'affichage d'une photo : recadrage sur l'étiquette si le cadre est
 * plausible, balance des blancs, étirement du contraste, netteté modérée,
 * 1200 px au plus, JPEG qualité 85. Lève si l'image est illisible.
 */
export async function buildDisplayImage(input: Buffer, box: LabelBox | null): Promise<Buffer> {
  const { width, height } = await sharp(input).metadata();
  if (!width || !height) throw new Error('Dimensions de l’image inconnues');

  let base = sharp(input).removeAlpha();
  if (plausibleLabelBox(box)) base = base.extract(cropRect(box, width, height));
  // Matérialisé avant les statistiques : la balance des blancs se calcule sur
  // l'étiquette recadrée, pas sur le décor autour.
  // Pixels bruts : pas de compression JPEG intermédiaire.
  const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };

  const { channels } = await sharp(data, raw).stats();
  let pipeline = sharp(data, raw);
  if (channels.length >= 3) {
    const factors = grayWorldFactors([channels[0].mean, channels[1].mean, channels[2].mean]);
    pipeline = pipeline.linear(factors, [0, 0, 0]);
  }
  return pipeline
    .normalise()
    .sharpen({ sigma: 1 })
    .resize({ width: DISPLAY_MAX_SIDE, height: DISPLAY_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
