import { Controller, Logger, OnModuleDestroy, Param, ParseUUIDPipe, Sse, UseGuards } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { Observable } from 'rxjs';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CaveRole, CurrentCave } from '../caves/cave-access.decorators';
import { CaveAccessGuard } from '../caves/cave-access.guard';
import type { CaveAccess } from '../caves/cave-context.service';
import { EXTRACTION_QUEUE, redisConnection } from '../queue/extraction.queue';
import { PhotoEvent, photoEventStream } from './photo-events';
import { PhotosService } from './photos.service';

/** Suivi d'analyse d'une photo : propriétaire, photo de la cave courante (résolue à l'ouverture). */
@Controller('photos')
@UseGuards(AuthenticatedGuard, CaveAccessGuard)
export class PhotoEventsController implements OnModuleDestroy {
  private readonly logger = new Logger(PhotoEventsController.name);
  // QueueEvents duplique la connexion qu'on lui donne et ne ferme que la copie :
  // on garde l'originale sous la main pour la quitter avec le module.
  private readonly connection = redisConnection();
  private readonly events = new QueueEvents(EXTRACTION_QUEUE, { connection: this.connection });

  constructor(private readonly photos: PhotosService) {
    this.events.setMaxListeners(0);
    this.events.on('error', (err) => this.logger.error(`QueueEvents : ${err.message}`));
  }

  // QueueEvents tient sa propre connexion Redis (bloquante) : elle doit être fermée
  // avec le module, sinon le process ne s'arrête jamais.
  async onModuleDestroy() {
    await this.events.close();
    await this.connection.quit();
  }

  /**
   * La photo est cherchée dans la cave courante avant d'ouvrir le flux : une
   * photo d'une autre cave rend un 404 ordinaire, pas un flux. Chaque envoi
   * relit la photo dans cette même cave.
   */
  @Sse(':id/events')
  @CaveRole('OWNER')
  async stream(@CurrentCave() cave: CaveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Observable<PhotoEvent>> {
    await this.photos.findInCave(cave.caveId, id);
    return photoEventStream(this.events, id, () => this.photos.findInCave(cave.caveId, id));
  }
}
