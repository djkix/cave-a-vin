import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import { EXTRACTION_JSON_SCHEMA_DESCRIPTION, parseExtraction } from './extraction-schema';
import { parsePairingOutput, PairingInvalidOutputError } from './pairing-output';
import { PairingProvider, PairingResult, PairingWine } from './pairing-provider.interface';
import { BatchVisionResult, VisionProvider, VisionResult, WineExtraction } from './vision-provider.interface';

export class VisionInvalidOutputError extends Error {}

/** Lot mélangé (JSON illisible, pas un tableau, longueur ≠ N, indice manquant/dupliqué/hors bornes) :
 * attrapée par le processeur de lot, qui relit alors photo par photo. */
export class VisionBatchMismatchError extends Error {}

const PROMPT = `Tu lis une étiquette de vin (ou un carton de vin) photographiée. Réponds UNIQUEMENT par un objet JSON strict de cette forme :
${EXTRACTION_JSON_SCHEMA_DESCRIPTION}
Règles :
- N'invente jamais un champ absent de l'image : un champ illisible ou absent vaut null avec confidence 0.
- Donne une confiance par champ, entre 0 et 1.
- Distingue le nom du producteur (domaine, château, maison) du nom de la cuvée.
- Sur un carton, lis le nombre de bouteilles s'il est imprimé (« 6 bouteilles », « caisse de 12 »), sinon null.
- "couleur" ∈ rouge | blanc | rosé | pétillant.
- "format_cl" en centilitres (75 par défaut uniquement si l'image le confirme, sinon null).`;

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

const stripFences = (text: string) => text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

const BATCH_INSTRUCTION = (n: number) =>
  `Tu reçois ${n} images numérotées de 1 à ${n}. Réponds par un tableau JSON de ${n} objets, dans l'ordre, chacun avec un champ "image" (numéro) et les champs ci-dessus.`;

const COLOR_WORD: Record<string, string> = { ROUGE: 'rouge', BLANC: 'blanc', ROSE: 'rosé', PETILLANT: 'pétillant' };

function pairingPrompt(w: PairingWine): string {
  return `Tu es sommelier. Propose de 5 à 8 plats qui s'accordent avec ce vin.
Réponds UNIQUEMENT par un objet JSON strict de la forme {"plats": string[]}.
Chaque plat : un nom court en français (60 caractères au plus), sans phrase ni explication.
Vin : producteur « ${w.producer} » ; cuvée « ${w.cuvee ?? 'aucune'} » ; appellation « ${w.appellation} » ; région « ${w.region ?? 'inconnue'} » ; couleur ${COLOR_WORD[w.color] ?? w.color} ; ${w.vintage == null ? 'non millésimé' : `millésime ${w.vintage}`}.`;
}

export class GeminiVisionProvider implements VisionProvider, PairingProvider {
  constructor(
    private readonly model: Pick<GenerativeModel, 'generateContent'>,
    private readonly modelName: string,
  ) {}

  static fromApiKey(apiKey: string, modelName: string): GeminiVisionProvider {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
    return new GeminiVisionProvider(model, modelName);
  }

  async extractWineLabel(image: Buffer, mimeType: string): Promise<VisionResult> {
    const started = Date.now();
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { data: image.toString('base64'), mimeType } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const latencyMs = Date.now() - started;
    const text = stripFences(result.response.text());

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new VisionInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
    }
    let extraction;
    try {
      extraction = parseExtraction(raw);
    } catch (e) {
      throw new VisionInvalidOutputError(`Sortie du modèle invalide : ${(e as Error).message}`);
    }

    const costCents = costCentsOf(result.response.usageMetadata);
    return { extraction, raw, model: this.modelName, latencyMs, costCents };
  }

  async extractWineLabels(images: Array<{ data: Buffer; mimeType: string }>): Promise<BatchVisionResult> {
    const n = images.length;
    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
      { text: `${PROMPT}\n${BATCH_INSTRUCTION(n)}` },
    ];
    images.forEach((image, i) => {
      parts.push({ text: `Image ${i + 1} :` });
      parts.push({ inlineData: { data: image.data.toString('base64'), mimeType: image.mimeType } });
    });

    const started = Date.now();
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const latencyMs = Date.now() - started;
    const text = stripFences(result.response.text());

    let rawArray: unknown;
    try {
      rawArray = JSON.parse(text);
    } catch {
      throw new VisionBatchMismatchError('Sortie du modèle invalide (JSON illisible)');
    }
    if (!Array.isArray(rawArray) || rawArray.length !== n) {
      throw new VisionBatchMismatchError('Sortie du modèle invalide (tableau de taille incorrecte)');
    }

    const items = new Array<{ raw: unknown; extraction: WineExtraction } | { error: string }>(n);
    const seen = new Set<number>();
    for (const obj of rawArray as unknown[]) {
      const index = (obj as { image?: unknown } | null)?.image;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > n) {
        throw new VisionBatchMismatchError('Sortie du modèle invalide (indice hors bornes)');
      }
      if (seen.has(index)) {
        throw new VisionBatchMismatchError('Sortie du modèle invalide (indice dupliqué)');
      }
      seen.add(index);

      try {
        items[index - 1] = { raw: obj, extraction: parseExtraction(obj) };
      } catch {
        items[index - 1] = { error: 'Lecture de l’étiquette inexploitable' };
      }
    }
    if (seen.size !== n) {
      throw new VisionBatchMismatchError('Sortie du modèle invalide (indice manquant)');
    }

    const costCents = costCentsOf(result.response.usageMetadata);
    return { items, model: this.modelName, latencyMs, costCents };
  }

  async suggestPairings(wine: PairingWine): Promise<PairingResult> {
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: pairingPrompt(wine) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    });
    let raw: unknown;
    try {
      raw = JSON.parse(stripFences(result.response.text()));
    } catch {
      throw new PairingInvalidOutputError('Sortie du modèle invalide (JSON illisible)');
    }
    return { dishes: parsePairingOutput(raw), model: this.modelName, costCents: pairingCostCentsOf(result.response.usageMetadata) };
  }
}
