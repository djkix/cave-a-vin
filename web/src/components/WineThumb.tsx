import { Icon } from './Icon';

/** Photo d'entrée du vin, ou un pictogramme quand le vin a été saisi sans photo. */
export function WineThumb({ photoId, size = 56 }: { photoId: string | null; size?: number }) {
  if (!photoId) {
    return (
      <span className="thumb thumb--empty" style={{ width: size, height: size * 1.25 }} aria-label="Pas de photo" role="img">
        <Icon name="wine_bar" />
      </span>
    );
  }
  return (
    <img className="thumb" src={`/api/photos/${photoId}/image`} alt="" width={size} height={size * 1.25} loading="lazy" decoding="async" />
  );
}
