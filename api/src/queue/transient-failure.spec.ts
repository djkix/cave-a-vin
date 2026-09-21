import { VisionInvalidOutputError } from '../vision/gemini-vision.provider';
import { deferralReason, isTransientVisionFailure } from './transient-failure';
import { VisionBudgetExceededError } from './vision-budget.service';

// Message relevé tel quel dans les logs du worker le 21/09/2026, quand les deux
// premières photos scannées en production sont parties en échec.
const GEMINI_503 = new Error(
  '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent: ' +
    '[503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
);

describe('isTransientVisionFailure', () => {
  it('traite la saturation du modèle (503) comme passagère', () => {
    expect(isTransientVisionFailure(GEMINI_503)).toBe(true);
  });

  it.each([429, 500, 502, 504])('traite le statut %i comme passager', (status) => {
    expect(isTransientVisionFailure(new Error(`[${status} Oups] plus tard`))).toBe(true);
  });

  it.each(['fetch failed', 'connect ECONNREFUSED 10.0.0.2:443', 'getaddrinfo EAI_AGAIN generativelanguage.googleapis.com'])(
    'traite l’erreur réseau « %s » comme passagère',
    (message) => {
      expect(isTransientVisionFailure(new Error(message))).toBe(true);
    },
  );

  it('traite le plafond mensuel comme passager : il repart au mois suivant', () => {
    expect(isTransientVisionFailure(new VisionBudgetExceededError())).toBe(true);
  });

  it('traite une sortie de modèle inexploitable comme définitive', () => {
    expect(isTransientVisionFailure(new VisionInvalidOutputError('Sortie du modèle invalide (JSON illisible)'))).toBe(false);
  });

  it.each([
    '[400 Bad Request] API key not valid. Please pass a valid API key.',
    '[403 Forbidden] Generative Language API has not been used in project 1234 before or it is disabled',
    '[404 Not Found] models/gemini-x is not found for API version v1beta',
  ])('traite l’erreur de configuration « %s » comme définitive', (message) => {
    expect(isTransientVisionFailure(new Error(message))).toBe(false);
  });

  it('considère une erreur inconnue comme passagère, pour ne jamais perdre la photo', () => {
    expect(isTransientVisionFailure(new Error('quelque chose d’inattendu'))).toBe(true);
  });
});

describe('deferralReason', () => {
  it('remplace la trace brute du SDK par une phrase lisible sur un téléphone', () => {
    expect(deferralReason(GEMINI_503)).toBe('Analyse reportée : service Gemini momentanément saturé, reprise automatique');
    expect(deferralReason(GEMINI_503)).not.toContain('googleapis.com');
  });

  it('distingue le quota du moment', () => {
    expect(deferralReason(new Error('[429 Too Many Requests] quota'))).toContain('quota Gemini atteint');
  });

  it('distingue un service injoignable', () => {
    expect(deferralReason(new Error('fetch failed'))).toContain('injoignable');
  });

  it('garde le message du plafond mensuel, qui explique déjà quoi faire', () => {
    expect(deferralReason(new VisionBudgetExceededError())).toContain('Plafond mensuel');
  });
});
