const DEFAULT_MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

/**
 * Réduit une photo prise au téléphone pour accélérer son envoi : côté le plus
 * long ramené à `maxDimension` (1600 px par défaut, 2400 pour le plan de la cave), encodée en JPEG qualité 0,8. N'agrandit jamais une
 * photo déjà plus petite. Si une étape échoue ou que l'API manque (navigateur
 * trop ancien, format illisible…), la photo d'origine est renvoyée telle quelle
 * — la réduction est une optimisation, jamais un blocage.
 */
export async function shrinkPhoto(file: Blob, maxDimension = DEFAULT_MAX_DIMENSION): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  try {
    // `imageOrientation: 'from-image'` applique la rotation EXIF à la bitmap
    // (largeur/hauteur déjà dans le bon sens) : sans ça, une photo portrait
    // prise au téléphone ressortirait couchée une fois le canvas ré-encodé,
    // l'EXIF n'étant pas conservé par toBlob.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const { width, height } = bitmap;
      const longest = Math.max(width, height);
      if (longest <= maxDimension) return file;
      const scale = maxDimension / longest;
      const targetWidth = Math.round(width * scale);
      const targetHeight = Math.round(height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      return blob ?? file;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return file;
  }
}
