import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import { EXTRACTION_JSON_SCHEMA_DESCRIPTION, parseExtraction } from './extraction-schema';
import { GeminiJournal, GeminiUsage, classifyFailure } from './gemini-journal';
import { parsePairingOutput, PairingInvalidOutputError } from './pairing-output';
import { PairingProvider, PairingResult, PairingWine } from './pairing-provider.interface';
import { parseProducerOutput, ProducerInvalidOutputError } from './producer-output';
import { OfficialSiteProvider, OfficialSiteQuery, OfficialSiteResult } from './official-site-provider.interface';
import { ProducerProvider, ProducerQuery, ProducerResult } from './producer-provider.interface';
import { BatchVisionResult, LabelPurpose, VisionProvider, VisionResult, WineExtraction } from './vision-provider.interface';

export class VisionInvalidOutputError extends Error {
  /** `costCents` : l'appel a abouti et il est facturé même si sa sortie est inexploitable. */
  constructor(message: string, readonly costCents = 0) {
    super(message);
  }
}

/** Lot mélangé (JSON illisible, pas un tableau, longueur ≠ N, indice manquant/dupliqué/hors bornes) :
 * attrapée par le processeur de lot, qui relit alors photo par photo. */
export class VisionBatchMismatchError extends Error {
  /** `costCents` : l'appel a abouti et il est facturé même si sa sortie est inexploitable. */
  constructor(message: string, readonly costCents = 0) {
    super(message);
  }
}

/** Règles de lecture communes aux consignes simple et de lot : une seule source, pour qu'elles ne divergent pas. */
const READING_RULES = `Règles :
- N'invente jamais un champ absent de l'image : un champ illisible ou absent vaut null avec confidence 0.
- Donne une confiance par champ, entre 0 et 1.
- Distingue le nom du producteur (domaine, château, maison) du nom de la cuvée.
- Sur un carton, lis le nombre de bouteilles s'il est imprimé (« 6 bouteilles », « caisse de 12 »), sinon null.
- "couleur" ∈ rouge | blanc | rosé | pétillant.
- "format_cl" en centilitres (75 par défaut uniquement si l'image le confirme, sinon null).
- "etiquette" : le cadre de l'étiquette principale sur la photo, [ymin, xmin, ymax, xmax] en coordonnées normalisées de 0 à 1000 (0,0 = coin haut gauche), ou null si l'étiquette n'est pas repérable.`;

const PROMPT = `Tu lis une étiquette de vin (ou un carton de vin) photographiée. Réponds UNIQUEMENT par un objet JSON strict de cette forme :
${EXTRACTION_JSON_SCHEMA_DESCRIPTION}
${READING_RULES}`;

/** Consigne de lot : la réponse attendue est un tableau, jamais un objet (sinon le modèle hésite entre les deux). */
const batchPrompt = (n: number) =>
  `Tu lis des étiquettes de vin (ou des cartons de vin) photographiées. Tu reçois ${n} images numérotées de 1 à ${n}.
Réponds UNIQUEMENT par un tableau JSON de ${n} éléments, un par image, dans l'ordre des images.
Chaque élément est un objet avec un champ "image" (le numéro de l'image, de 1 à ${n}) et exactement les champs suivants :
${EXTRACTION_JSON_SCHEMA_DESCRIPTION}
${READING_RULES}`;

// Ordre de grandeur pour le plafond mensuel ; ajuster si la grille tarifaire change.
const PRICE_PER_1K_TOKENS_CENTS = { input: 0.01, output: 0.04 };

function rawCostCentsOf(usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): number {
  return (
    ((usage?.promptTokenCount ?? 0) / 1000) * PRICE_PER_1K_TOKENS_CENTS.input +
    ((usage?.candidatesTokenCount ?? 0) / 1000) * PRICE_PER_1K_TOKENS_CENTS.output
  );
}

/** Une photo facturée par Gemini ne doit jamais être comptée à coût nul : on majore toujours. */
function costCentsOf(usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): number {
  return Math.ceil(rawCostCentsOf(usage));
}

/** Un accord coûte un ordre de grandeur de moins qu'une photo (~0,004 ct) : arrondir plutôt que
 * majorer évite qu'il consomme systématiquement 1 ct du plafond mensuel partagé avec les photos. */
function pairingCostCentsOf(usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): number {
  return Math.round(rawCostCentsOf(usage));
}

/** Ordre de grandeur du prix d'une requête de recherche ancrée (~35 $ les 1000 requêtes). */
const PRICE_PER_GROUNDED_QUERY_CENTS = 1.4;

/**
 * Un appel ancré sur la recherche Google est facturé à part, par requête de
 * recherche lancée (`groundingMetadata.webSearchQueries`), et les jetons des
 * résultats (`toolUsePromptTokenCount`) s'ajoutent à l'entrée : compter au moins
 * 1 ct par appel, et le plus élevé des deux coûts (jetons, requêtes), majoré, pour
 * que le plafond mensuel voie réellement cette dépense.
 */
function groundedCostCentsOf(
  usage: { promptTokenCount?: number; candidatesTokenCount?: number; toolUsePromptTokenCount?: number } | undefined,
  searchQueries: number,
): number {
  const tokens = rawCostCentsOf({
    promptTokenCount: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    candidatesTokenCount: usage?.candidatesTokenCount,
  });
  return Math.max(1, Math.ceil(tokens), Math.ceil(searchQueries * PRICE_PER_GROUNDED_QUERY_CENTS));
}

/** Nombre de requêtes de recherche lancées par Gemini pour un appel ancré (0 si la réponse ne le dit pas). */
function searchQueriesOf(response: { candidates?: Array<{ groundingMetadata?: { webSearchQueries?: unknown } }> }): number {
  const queries = response.candidates?.[0]?.groundingMetadata?.webSearchQueries;
  return Array.isArray(queries) ? queries.length : 0;
}

const stripFences = (text: string) => text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

/**
 * Le modèle enveloppe parfois le tableau demandé dans un objet (`{"items": […]}`) :
 * un objet dont une seule propriété est un tableau est ramené à ce tableau, tout
 * autre forme reste telle quelle (et sera refusée comme lot mélangé).
 */
function unwrapArray(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const arrays = Object.values(value).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : value;
}

const COLOR_WORD: Record<string, string> = { ROUGE: 'rouge', BLANC: 'blanc', ROSE: 'rosé', PETILLANT: 'pétillant' };

function pairingPrompt(w: PairingWine): string {
  return `Tu es sommelier. Propose de 5 à 8 plats qui s'accordent avec ce vin.
Réponds UNIQUEMENT par un objet JSON strict de la forme {"plats": string[]}.
Chaque plat : un nom court en français (60 caractères au plus), sans phrase ni explication.
Vin : producteur « ${w.producer} » ; cuvée « ${w.cuvee ?? 'aucune'} » ; appellation « ${w.appellation} » ; région « ${w.region ?? 'inconnue'} » ; couleur ${COLOR_WORD[w.color] ?? w.color} ; ${w.vintage == null ? 'non millésimé' : `millésime ${w.vintage}`}.`;
}

function producerPrompt(q: ProducerQuery): string {
  return `Tu es sommelier. Présente ce domaine viticole en 3 à 4 phrases en français : le lieu (région, village), quelques repères d'histoire, le style de ses vins (cépages).
Réponds UNIQUEMENT par un objet JSON strict de la forme {"connu": true, "description": string}.
Si tu ne connais pas ce domaine de façon fiable, n'invente rien et réponds exactement {"connu": false}.
Domaine : « ${q.producer} » ; appellation(s) de ses vins : ${q.appellations.length ? q.appellations.map((a) => `« ${a} »`).join(', ') : 'inconnue'} ; région « ${q.region ?? 'inconnue'} ».`;
}

function officialSitePrompt(q: OfficialSiteQuery): string {
  return `Trouve, avec la recherche Google, l'adresse du site officiel du domaine viticole qui produit ce vin (le site du domaine lui-même, pas un caviste, un guide ni un réseau social).
Réponds UNIQUEMENT par un objet JSON strict de la forme {"site": "https://…"}.
Si tu ne trouves pas de site officiel de façon fiable, réponds exactement {"site": null}.
Vin : producteur « ${q.producer} » ; cuvée « ${q.cuvee ?? 'aucune'} » ; appellation « ${q.appellation} » ; ${q.vintage == null ? 'non millésimé' : `millésime ${q.vintage}`}.`;
}

/** Une réponse ancrée sur la recherche Google n'est pas garantie en JSON pur : on prend le premier objet du texte. */
function siteOf(text: string): string | null {
  const match = stripFences(text).match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const site = (raw as { site?: unknown } | null)?.site;
  if (typeof site !== 'string') return null;
  try {
    const url = new URL(site.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * L'outil de recherche Google de Gemini 3 n'est pas encore typé par
 * `@google/generative-ai` (qui ne connaît que `googleSearchRetrieval`) : la
 * requête passe par ce type élargi, le reste de l'appel est inchangé.
 */
type GroundedRequest = Parameters<GenerativeModel['generateContent']>[0] & { tools: Array<{ googleSearch: Record<string, never> }> };

export class GeminiVisionProvider implements VisionProvider, PairingProvider, ProducerProvider, OfficialSiteProvider {
  /**
   * `journal` : point de passage unique de tous les appels (voir `call`). Sans
   * journal (tests unitaires des consignes), les appels partent tels quels.
   */
  constructor(
    private readonly model: Pick<GenerativeModel, 'generateContent'>,
    private readonly modelName: string,
    private readonly journal?: GeminiJournal,
  ) {}

  static fromApiKey(apiKey: string, modelName: string, journal?: GeminiJournal): GeminiVisionProvider {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
    return new GeminiVisionProvider(model, modelName, journal);
  }

  /**
   * Chaque méthode publique passe par ici : pendant une pause commune, aucun
   * appel ne part (`GeminiPausedError`) et rien n'est noté ; sinon une ligne
   * `gemini_call` par requête envoyée, réussie, refusée (429, 503 : la pause
   * est posée) ou en erreur. Le journal ne lève jamais.
   */
  private async call<T extends { costCents: number }>(usage: GeminiUsage, run: () => Promise<T>): Promise<T> {
    if (!this.journal) return run();
    await this.journal.assertNotPaused();
    const started = Date.now();
    let result: T;
    try {
      result = await run();
    } catch (e) {
      await this.journal.record({ usage, ...classifyFailure(e), durationMs: Date.now() - started });
      throw e;
    }
    await this.journal.record({ usage, outcome: 'OK', httpStatus: null, reason: null, costCents: result.costCents, durationMs: Date.now() - started });
    return result;
  }

  /**
   * Photo seule : `EXIT` pour une sortie (ExtractionProcessor), `ENTRY` pour une
   * photo d'entrée relue seule par le lot (EntryBatchProcessor) ; sert à
   * distinguer lecture d'entrée et de sortie dans le journal des appels.
   */
  extractWineLabel(image: Buffer, mimeType: string, purpose: LabelPurpose = 'EXIT'): Promise<VisionResult> {
    return this.call(purpose === 'ENTRY' ? 'LECTURE_ENTREE' : 'LECTURE_SORTIE', () => this.readLabel(image, mimeType));
  }

  private async readLabel(image: Buffer, mimeType: string): Promise<VisionResult> {
    const started = Date.now();
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { data: image.toString('base64'), mimeType } }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    const latencyMs = Date.now() - started;
    const costCents = costCentsOf(result.response.usageMetadata);
    const text = stripFences(result.response.text());

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new VisionInvalidOutputError('Sortie du modèle invalide (JSON illisible)', costCents);
    }
    let extraction;
    try {
      extraction = parseExtraction(raw);
    } catch (e) {
      throw new VisionInvalidOutputError(`Sortie du modèle invalide : ${(e as Error).message}`, costCents);
    }

    return { extraction, raw, model: this.modelName, latencyMs, costCents };
  }

  extractWineLabels(images: Array<{ data: Buffer; mimeType: string }>): Promise<BatchVisionResult> {
    return this.call('LECTURE_ENTREE', () => this.readLabels(images));
  }

  private async readLabels(images: Array<{ data: Buffer; mimeType: string }>): Promise<BatchVisionResult> {
    const n = images.length;
    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
      { text: batchPrompt(n) },
    ];
    images.forEach((image, i) => {
      parts.push({ text: `Image ${i + 1} :` });
      parts.push({ inlineData: { data: image.data.toString('base64'), mimeType: image.mimeType } });
    });

    const started = Date.now();
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    const latencyMs = Date.now() - started;
    const costCents = costCentsOf(result.response.usageMetadata);
    const text = stripFences(result.response.text());

    let rawArray: unknown;
    try {
      rawArray = unwrapArray(JSON.parse(text));
    } catch {
      throw new VisionBatchMismatchError('Sortie du modèle invalide (JSON illisible)', costCents);
    }
    if (!Array.isArray(rawArray) || rawArray.length !== n) {
      throw new VisionBatchMismatchError('Sortie du modèle invalide (tableau de taille incorrecte)', costCents);
    }

    const items = new Array<{ raw: unknown; extraction: WineExtraction } | { error: string }>(n);
    const seen = new Set<number>();
    for (const obj of rawArray as unknown[]) {
      const index = (obj as { image?: unknown } | null)?.image;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > n) {
        throw new VisionBatchMismatchError('Sortie du modèle invalide (indice hors bornes)', costCents);
      }
      if (seen.has(index)) {
        throw new VisionBatchMismatchError('Sortie du modèle invalide (indice dupliqué)', costCents);
      }
      seen.add(index);

      try {
        items[index - 1] = { raw: obj, extraction: parseExtraction(obj) };
      } catch {
        items[index - 1] = { error: 'Lecture de l’étiquette inexploitable' };
      }
    }
    if (seen.size !== n) {
      throw new VisionBatchMismatchError('Sortie du modèle invalide (indice manquant)', costCents);
    }

    return { items, model: this.modelName, latencyMs, costCents };
  }

  suggestPairings(wine: PairingWine): Promise<PairingResult> {
    return this.call('ACCORDS', () => this.pairings(wine));
  }

  private async pairings(wine: PairingWine): Promise<PairingResult> {
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: pairingPrompt(wine) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    let raw: unknown;
    try {
      raw = JSON.parse(stripFences(result.response.text()));
    } catch {
      throw new PairingInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
    }
    return { dishes: parsePairingOutput(raw), model: this.modelName, costCents: pairingCostCentsOf(result.response.usageMetadata) };
  }

  describeProducer(query: ProducerQuery): Promise<ProducerResult> {
    return this.call('DESCRIPTIF', () => this.producer(query));
  }

  private async producer(query: ProducerQuery): Promise<ProducerResult> {
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: producerPrompt(query) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    let raw: unknown;
    try {
      raw = JSON.parse(stripFences(result.response.text()));
    } catch {
      throw new ProducerInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
    }
    const output = parseProducerOutput(raw);
    return {
      known: output.known,
      description: output.known ? output.description : null,
      model: this.modelName,
      costCents: pairingCostCentsOf(result.response.usageMetadata),
    };
  }

  /**
   * Site officiel du domaine, trouvé par Gemini avec la recherche Google. Pas de
   * `responseMimeType` JSON : il n'est pas garanti avec un outil de recherche, la
   * consigne suffit et la réponse est lue avec tolérance. Coût : au moins 1 ct,
   * et par requête de recherche (voir `groundedCostCentsOf`). Une réponse
   * inexploitable vaut « pas de site » (l'appel reste facturé). `signal` : délai
   * global de la recherche d'image, l'appel est abandonné quand il est levé.
   */
  findOfficialSite(query: OfficialSiteQuery, signal?: AbortSignal): Promise<OfficialSiteResult> {
    return this.call('RECHERCHE_IMAGE', () => this.officialSite(query, signal));
  }

  private async officialSite(query: OfficialSiteQuery, signal?: AbortSignal): Promise<OfficialSiteResult> {
    const request: GroundedRequest = {
      contents: [{ role: 'user', parts: [{ text: officialSitePrompt(query) }] }],
      tools: [{ googleSearch: {} }],
    };
    const result = await this.model.generateContent(request as Parameters<GenerativeModel['generateContent']>[0], { signal });
    let text = '';
    try {
      text = result.response.text();
    } catch {
      // Réponse bloquée ou vide : pas de site.
    }
    return { site: siteOf(text), model: this.modelName, costCents: groundedCostCentsOf(result.response.usageMetadata, searchQueriesOf(result.response)) };
  }
}
