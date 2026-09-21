import { loadEnv } from '../config/env';

// ADMIN_EMAILS est un plancher garanti, jamais un plafond : l'environnement
// assure que le propriétaire ne peut jamais s'enfermer dehors, mais une
// promotion faite depuis /admin sur un autre compte reste durable (voir
// AuthService.resolveIsAdmin et AdminService.updateUser). Partagé entre les
// deux services pour éviter un doublon de lecture d'ADMIN_EMAILS.
export function adminEmailsFromEnv(): string[] {
  return loadEnv()
    .ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}
