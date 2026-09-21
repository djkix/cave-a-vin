import { Controller, Logger, Param, Sse, UseGuards } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { Observable } from 'rxjs';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { EXTRACTION_QUEUE, redisConnection } from '../queue/extraction.queue';
import { parseExtraction } from '../vision/extraction-schema';
import { PhotosService } from './photos.service';

interface PhotoEvent {
  data: { status: string; extraction?: unknown; errorMessage?: string | null };
}

@Controller('photos')
@UseGuards(AuthenticatedGuard)
export class PhotoEventsController {
  private readonly logger = new Logger(PhotoEventsController.name);
  private readonly events = new QueueEvents(EXTRACTION_QUEUE, { connection: redisConnection() });

  constructor(private readonly photos: PhotosService) {
    this.events.setMaxListeners(0);
    this.events.on('error', (err) => this.logger.error(`QueueEvents : ${err.message}`));
  }

  @Sse(':id/events')
  stream(@Param('id') id: string): Observable<PhotoEvent> {
    return new Observable((subscriber) => {
      const emit = async () => {
        const photo = await this.photos.findById(id);
        const data: PhotoEvent['data'] = { status: photo.status, errorMessage: photo.errorMessage };
        if (photo.status === 'DONE' && photo.rawExtraction) data.extraction = parseExtraction(photo.rawExtraction);
        subscriber.next({ data });
        if (photo.status === 'DONE' || photo.status === 'FAILED') subscriber.complete();
      };
      const safeEmit = () => {
        emit().catch((e) => subscriber.error(e));
      };
      const onDone = ({ jobId }: { jobId: string }) => { if (jobId === id) safeEmit(); };
      this.events.on('completed', onDone);
      this.events.on('failed', onDone);
      safeEmit();
      return () => {
        this.events.off('completed', onDone);
        this.events.off('failed', onDone);
      };
    });
  }
}
