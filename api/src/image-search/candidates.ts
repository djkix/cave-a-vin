import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { safeFetch } from './safe-fetch';
import { Fetcher, RemoteImage } from './types';

export const CANDIDATE_TTL_MS = 60 * 60 * 1000;
const CANDIDATE_MAX_BYTES = 5 * 1024 * 1024;
const CANDIDATE_MAX_SIDE = 1200;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CandidateExpiredError extends Error {
  constructor() {
    super('Proposition expirée, relancez la recherche');
  }
}

export interface CandidateMeta {
  id: string;
  source: string;
  sourceUrl: string;
  createdAt: string;
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Images proposées par « Chercher une image » : téléchargées par le serveur
 * (jamais par le navigateur, qui ne voit que `/api/image-candidates/:id`),
 * ramenées à un JPEG de 1200 px au plus et gardées une heure dans
 * `<PHOTO_STORAGE_DIR>/candidates/`, avec leurs métadonnées dans un `.json`
 * voisin (elles survivent ainsi à un redémarrage de l'api). Les candidates
 * périmées sont effacées à chaque nouvelle recherche.
 */
export class CandidateStore {
  private readonly logger = new Logger(CandidateStore.name);
  private readonly dir: string;

  constructor(
    storageDir: string,
    private readonly fetcher: Fetcher = safeFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(storageDir, 'candidates');
  }

  private paths(id: string) {
    return { image: join(this.dir, `${id}.jpg`), meta: join(this.dir, `${id}.json`) };
  }

  /** Télécharge et garde une image ; null si elle est inaccessible, trop lourde ou d'un type refusé. */
  async add(remote: RemoteImage): Promise<CandidateMeta | null> {
    let jpeg: Buffer;
    try {
      const res = await this.fetcher(remote.imageUrl, { maxBytes: CANDIDATE_MAX_BYTES, headers: { Accept: 'image/jpeg,image/png,image/webp' } });
      const type = res.contentType?.split(';')[0].trim().toLowerCase() ?? '';
      if (!ACCEPTED_TYPES.has(type)) throw new Error(`type ${type || 'inconnu'} refusé`);
      const image = sharp(res.buffer, { limitInputPixels: 50_000_000 });
      const { format } = await image.metadata();
      if (!format || !ACCEPTED_FORMATS.has(format)) throw new Error(`contenu ${format ?? 'illisible'} refusé`);
      jpeg = await image
        .rotate()
        .resize(CANDIDATE_MAX_SIDE, CANDIDATE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (e) {
      this.logger.warn(`Image proposée écartée (${remote.imageUrl}) : ${(e as Error).message}`);
      return null;
    }
    const meta: CandidateMeta = { id: randomUUID(), source: remote.source, sourceUrl: remote.sourceUrl, createdAt: new Date(this.now()).toISOString() };
    const { image, meta: metaPath } = this.paths(meta.id);
    await mkdir(this.dir, { recursive: true });
    await writeFile(image, jpeg);
    await writeFile(metaPath, JSON.stringify(meta));
    return meta;
  }

  /** Métadonnées d'une candidate encore valable ; sinon (inconnue, périmée, identifiant forgé) `CandidateExpiredError`. */
  async get(id: string): Promise<CandidateMeta> {
    if (!UUID.test(id)) throw new CandidateExpiredError();
    let meta: CandidateMeta;
    try {
      meta = JSON.parse(await readFile(this.paths(id).meta, 'utf8')) as CandidateMeta;
    } catch {
      throw new CandidateExpiredError();
    }
    if (this.isExpired(meta)) throw new CandidateExpiredError();
    return meta;
  }

  async read(id: string): Promise<Buffer> {
    await this.get(id);
    try {
      return await readFile(this.paths(id).image);
    } catch {
      throw new CandidateExpiredError();
    }
  }

  /** Déplace l'image d'une candidate vers `destination` (photo définitive) et l'oublie. */
  async take(id: string, destination: string): Promise<CandidateMeta> {
    const meta = await this.get(id);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(this.paths(id).image, destination);
    } catch {
      throw new CandidateExpiredError();
    }
    await unlinkQuietly(this.paths(id).meta);
    return meta;
  }

  /** Efface les candidates de plus d'une heure (et les fichiers orphelins du même âge). */
  async cleanup(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return;
    }
    const metaIds = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
    for (const id of metaIds) {
      let expired = true;
      try {
        expired = this.isExpired(JSON.parse(await readFile(this.paths(id).meta, 'utf8')) as CandidateMeta);
      } catch {
        // Métadonnées illisibles : la candidate est inutilisable, on l'efface.
      }
      if (expired) {
        await unlinkQuietly(this.paths(id).image);
        await unlinkQuietly(this.paths(id).meta);
      }
    }
    for (const file of files.filter((f) => !f.endsWith('.json') && !metaIds.has(f.replace(/\.jpg$/, '')))) {
      const path = join(this.dir, file);
      try {
        if (this.now() - (await stat(path)).mtimeMs > CANDIDATE_TTL_MS) await unlinkQuietly(path);
      } catch {
        // Fichier déjà parti : rien à faire.
      }
    }
  }

  private isExpired(meta: CandidateMeta): boolean {
    const created = Date.parse(meta.createdAt);
    return !Number.isFinite(created) || this.now() - created > CANDIDATE_TTL_MS;
  }
}
