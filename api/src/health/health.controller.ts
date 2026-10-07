import { Controller, Get } from '@nestjs/common';
import { AllowPending } from '../auth/allow-pending.decorator';

@Controller('health')
@AllowPending()
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
