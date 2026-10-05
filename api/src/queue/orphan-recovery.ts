export interface OrphanRecoveryPrisma {
  photo: {
    findMany(args: unknown): Promise<{ id: string }[]>;
    update(args: unknown): Promise<unknown>;
  };
}

/**
 * La photo est sur le disque, mais une sortie (EXIT) n'a de valeur que tant que
 * l'utilisateur est devant la bouteille : si le worker redémarre (conteneur
 * relancé, Redis vidé, travail abandonné) pendant qu'une sortie attend encore son
 * analyse, l'instant est passé — l'utilisateur a forcément continué autrement.
 * On l'abandonne donc tout de suite, avec un motif clair, plutôt que de la
 * laisser trainer « en attente » indéfiniment.
 *
 * Une entrée (ENTRY), elle, n'a plus de travail BullMQ à reprendre : son analyse
 * se fait par lot directement depuis la table photo (voir le worker de rafale),
 * et un redémarrage ne lui fait perdre ni sa place dans la file ni ses photos —
 * on la laisse donc intacte ici.
 */
export async function requeueOrphanPhotos(
  prisma: OrphanRecoveryPrisma,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const photos = await prisma.photo.findMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'EXIT' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const { id } of photos) {
    await prisma.photo.update({ where: { id }, data: { status: 'FAILED', errorMessage: 'Photo de sortie abandonnée au redémarrage' } });
  }

  if (photos.length > 0) log(`Reprise au démarrage : ${photos.length} photo(s) de sortie abandonnée(s)`);
  return photos.length;
}
