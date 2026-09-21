// ADMIN_EMAILS est un plancher garanti, jamais un plafond : l'environnement
// assure que le propriétaire ne peut jamais s'enfermer dehors, mais une
// promotion faite depuis /admin sur un autre compte reste durable (voir
// AuthService.resolveIsAdmin et AdminService.updateUser). Partagé entre les
// deux services pour éviter un doublon de lecture d'ADMIN_EMAILS.
//
// La lecture se fait sur process.env à chaque appel, et non via loadEnv(), dont
// le résultat est mémoïsé au premier appel : un test qui fixe ADMIN_EMAILS se
// verrait sinon imposer la valeur déjà en cache — c'est exactement ce qui avait
// fait échouer la suite en intégration continue, où le job définit sa propre
// valeur. La variable reste déclarée dans le schéma zod, qui documente et
// valide l'environnement attendu.
export function adminEmailsFromEnv(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}
