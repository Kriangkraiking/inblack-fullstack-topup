import { Logger } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service.js';

describe('HeartbeatService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should log on every interval until shutdown', () => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const service = new HeartbeatService();

    service.onApplicationBootstrap();
    expect(log).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(log).toHaveBeenCalledTimes(2);

    service.onApplicationShutdown();
    vi.advanceTimersByTime(60_000);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
