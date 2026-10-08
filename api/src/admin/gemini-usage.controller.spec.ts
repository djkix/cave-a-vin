import { BadRequestException } from '@nestjs/common';
import { AdminGeminiUsageController } from './admin.controller';

describe('AdminGeminiUsageController', () => {
  const usage = { report: jest.fn(async (days: number) => ({ days })) };
  const controller = new AdminGeminiUsageController(usage as any);

  beforeEach(() => usage.report.mockClear());

  it('7 jours par défaut', async () => {
    await controller.get(undefined);
    expect(usage.report).toHaveBeenCalledWith(7);
  });

  it('accepte de 1 à 90 jours', async () => {
    await controller.get('1');
    await controller.get('30');
    await controller.get('90');
    expect(usage.report.mock.calls.map((c) => c[0])).toEqual([1, 30, 90]);
  });

  it.each(['0', '91', '-3', '7.5', 'abc', ''])('refuse days=%s (400)', (days) => {
    expect(() => controller.get(days)).toThrow(BadRequestException);
    expect(usage.report).not.toHaveBeenCalled();
  });
});
