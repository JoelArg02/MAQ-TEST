import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { POLL_INTERVAL_MS } from './config';
import { ModbusService } from './modbus.service';
import { StorageService } from './storage.service';

@Injectable()
export class LoggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoggerService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly modbusService: ModbusService,
    private readonly storageService: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.storageService.markEvent('SYSTEM_START', 'Inicio del servidor y logger automatico');
    await this.captureNow();

    this.timer = setInterval(() => {
      void this.captureNow();
    }, POLL_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.storageService.markEvent('SYSTEM_STOP', 'Detencion del servidor');
  }

  async captureNow(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.polling = true;
    try {
      const snapshot = await this.modbusService.readAll();
      await this.storageService.saveSnapshot(snapshot.values, snapshot.timestamp, snapshot.epochSeconds);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`No se pudo capturar snapshot: ${message}`);
      await this.storageService.markEvent('CAPTURE_ERROR', message);
    } finally {
      this.polling = false;
    }
  }
}
