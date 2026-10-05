const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

/**
 * Réduit une photo prise au téléphone pour accélérer son envoi : côté le plus
 * long ramené à 1600 px, encodée en JPEG qualité 0,8. N'agrandit jamais une
 * photo déjà plus petite. Si une étape échoue ou que l'API manque (navigateur
 * trop ancien, format illisible…), la photo d'origine est renvoyée telle quelle
 * — la réduction est une optimisation, jamais un blocage.
 */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = bitmap;
      const longest = Math.max(width, height);
      if (longest <= MAX_DIMENSION) return file;
      const scale = MAX_DIMENSION / longest;
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
