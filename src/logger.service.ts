import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { POLL_INTERVAL_MS } from './config';
import { ModbusService } from './modbus.service';
import { StorageService } from './storage.service';

@Injectable()
export class LoggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoggerService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private pendingCapture = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly modbusService: ModbusService,
    private readonly storageService: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.storageService.markEvent('SYSTEM_START', 'Inicio del servidor y logger automatico');
    setTimeout(() => {
      void this.captureNow();
    }, 0);

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

  async captureNow(options?: { ensure?: boolean }): Promise<void> {
    const ensure = options?.ensure ?? false;

    if (this.polling) {
      if (!ensure) {
        return;
      }

      // Si hay una captura en curso, forzamos una captura adicional al terminar.
      this.pendingCapture = true;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
      return;
    }

    this.polling = true;
    try {
      do {
        this.pendingCapture = false;
        const snapshot = await this.modbusService.readAll();
        await this.storageService.saveSnapshot(snapshot.values, snapshot.timestamp, snapshot.epochSeconds);
      } while (this.pendingCapture);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`No se pudo capturar snapshot: ${message}`);
      await this.storageService.markEvent('CAPTURE_ERROR', message);
    } finally {
      this.polling = false;
      const toResolve = this.waiters.splice(0);
      for (const resolve of toResolve) {
        resolve();
      }
    }
  }
}
