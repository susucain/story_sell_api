import { Test, TestingModule } from '@nestjs/testing';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import { AppController } from '../../src/app.controller';
import { AppService } from '../../src/app.service';

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
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('is public so it can be used as the deployment health check', () => {
      expect(
        Reflect.getMetadata(IS_PUBLIC_KEY, AppController.prototype.getHello),
      ).toBe(true);
    });
  });
});
