import { Controller, Param, Sse, UseGuards } from '@nestjs/common';
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
  private readonly events = new QueueEvents(EXTRACTION_QUEUE, { connection: redisConnection() });

  constructor(private readonly photos: PhotosService) {}

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
      const onDone = ({ jobId }: { jobId: string }) => { if (jobId === id) void emit(); };
      this.events.on('completed', onDone);
      this.events.on('failed', onDone);
      void emit();
      return () => {
        this.events.off('completed', onDone);
        this.events.off('failed', onDone);
      };
    });
  }
}
