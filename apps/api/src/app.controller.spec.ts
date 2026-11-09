import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should report status with the instance id', () => {
      vi.stubEnv('INSTANCE_ID', 'api-test');

      expect(appController.getStatus()).toEqual({
        status: 'ok',
        service: 'api',
        instance: 'api-test',
      });

      vi.unstubAllEnvs();
    });
  });
});
