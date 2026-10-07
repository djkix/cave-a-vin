import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING = 'allowPending';

/**
 * Route (ou contrôleur) ouverte à un compte en attente de validation (voir
 * PendingGuard). `@AllowPending(false)` sur une méthode referme une route d'un
 * contrôleur ouvert.
 */
export const AllowPending = (allowed = true) => SetMetadata(ALLOW_PENDING, allowed);
