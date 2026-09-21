import { VisionBudgetExceededError } from './vision-budget.service';

/**
 * Codes HTTP qu'un réessai plus tard peut résoudre : saturation du modèle (503),
 * quota par minute (429), incident côté fournisseur (500, 502, 504). Le SDK
 * @google/generative-ai n'expose pas le statut sur l'objet d'erreur : il le place
 * entre crochets au début du message, sous la forme « [503 Service Unavailable] ».
 */
const TRANSIENT_STATUS = [429, 500, 502, 503, 504];

/**
 * Erreurs réseau de Node et d'undici. Une coupure de la liaison du serveur ne dit
 * rien sur la photo : elle doit être réanalysée telle quelle quand le lien revient.
 */
const TRANSIENT_NETWORK = [
  'fetch failed',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'socket hang up',
  'other side closed',
  'terminated',
];

/**
 * Erreurs dont on sait qu'un réessai ne changera rien : l'appel a bien abouti et
 * c'est la réponse qui est inexploitable, ou la configuration qui est fausse. Elles
 * doivent échouer tout de suite pour que la saisie manuelle soit proposée, au lieu
 * d'occuper la file pendant des jours.
 */
const DEFINITIVE = [
  'Sortie du modèle invalide',
  'API key not valid',
  'API_KEY_INVALID',
  'API key expired',
  'PERMISSION_DENIED',
  'has not been used in project',
  'is not found for API version',
];

/**
 * Le statut apparaît entre crochets n'importe où dans le message, jamais en tête :
 * un 503 de Gemini arrive sous la forme « [GoogleGenerativeAI Error]: Error fetching
 * from https://…:generateContent: [503 Service Unavailable] This model is currently
 * experiencing high demand. » On prend donc le premier groupe de trois chiffres
 * entre crochets, et non un préfixe de message.
 */
function statusFromMessage(message: string): number | null {
  const match = /\[(\d{3})\b/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * Une panne passagère ne doit jamais faire perdre une photo : elle est remise en
 * attente et réanalysée quand le service redevient disponible. Seules les erreurs
 * de la liste DEFINITIVE arrêtent le travail.
 *
 * Le défaut, pour une erreur inconnue, est donc « passagère » : garder la photo en
 * file et afficher le motif dans le compteur d'attente coûte un réessai inutile,
 * alors que l'abandon coûte la photo. Les erreurs vraiment définitives sont nommées
 * plutôt que devinées.
 */
export function isTransientVisionFailure(error: unknown): boolean {
  if (error instanceof VisionBudgetExceededError) return true; // repart au mois suivant
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (DEFINITIVE.some((needle) => message.includes(needle))) return false;
  const status = statusFromMessage(message);
  if (status !== null) return TRANSIENT_STATUS.includes(status);
  if (TRANSIENT_NETWORK.some((needle) => message.includes(needle))) return true;
  return true;
}

/**
 * Message affiché à l'écran et stocké sur la photo. Le texte brut du SDK (« Error
 * fetching from https://generativelanguage.googleapis.com/v1beta/models/… ») est
 * illisible sur un téléphone et tronqué par l'interface : on le remplace par une
 * phrase qui dit quoi faire, en gardant le détail dans les logs du worker.
 */
export function deferralReason(error: unknown): string {
  if (error instanceof VisionBudgetExceededError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  const status = statusFromMessage(message);
  if (status === 429) return 'Analyse reportée : quota Gemini atteint pour le moment, reprise automatique';
  if (status !== null && status >= 500) return 'Analyse reportée : service Gemini momentanément saturé, reprise automatique';
  if (TRANSIENT_NETWORK.some((needle) => message.includes(needle))) {
    return 'Analyse reportée : service Gemini injoignable, reprise automatique';
  }
  return 'Analyse reportée : reprise automatique dès que le service répond';
}
