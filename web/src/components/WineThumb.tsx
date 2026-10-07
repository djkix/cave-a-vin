import { useEffect, useState } from 'react';
import { Icon } from './Icon';

/**
 * Photo d'entrée du vin, ou un pictogramme quand le vin a été saisi sans photo —
 * ou quand la photo existe mais échoue à charger (fichier manquant, 404) : on ne
 * laisse jamais le navigateur afficher une image cassée.
 */
export function WineThumb({ photoId, size = 56 }: { photoId: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoId]);

  if (!photoId || failed) {
    return (
      <span className="thumb thumb--empty" style={{ width: size, height: size * 1.25 }} aria-label="Pas de photo" role="img">
        <Icon name="wine_bar" />
      </span>
    );
  }
  return (
    <img
      className="thumb"
      src={`/api/photos/${photoId}/image?variant=display`}
      alt=""
      width={size}
      height={size * 1.25}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
