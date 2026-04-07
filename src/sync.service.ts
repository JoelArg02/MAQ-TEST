import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { StorageService } from './storage.service';
import { SYNC_API_URL, KEY_BACK, SYNC_INTERVAL_MS, SYNC_BATCH_SIZE } from './config';
import { randomUUID } from 'crypto';

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(private readonly storage: StorageService) {}

  onModuleInit() {
    if (!SYNC_API_URL || !KEY_BACK) {
      this.logger.warn('SYNC_API_URL o KEY_BACK no configurada — sincronización desactivada');
      return;
    }
    this.logger.log(`Sync habilitado → ${SYNC_API_URL} cada ${SYNC_INTERVAL_MS}ms`);
    this.timer = setInterval(() => void this.tick(), SYNC_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.syncBatch();
    } catch (err) {
      this.logger.warn(`Sync error: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.syncing = false;
    }
  }

  private async syncBatch(): Promise<void> {
    const rows = await this.storage.getUnsyncedReadings(SYNC_BATCH_SIZE);
    if (rows.length === 0) return;

    const batchId = randomUUID();

    const readings = rows.map((r: Record<string, unknown>) => ({
      epochSeconds: r.epoch_seconds as number,
      address: r.address as number,
      name: r.name as string,
      type: r.type as string,
      valueNum: r.value_num as number | null,
      valueText: r.value_text as string | null,
    }));

    const res = await fetch(`${SYNC_API_URL}/api/production/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': KEY_BACK,
      },
      body: JSON.stringify({ batchId, capturedAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Guayaquil' }), readings, events: [] }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ingest failed: ${res.status} ${text.slice(0, 200)}`);
    }

    const ids = rows.map((r: Record<string, unknown>) => r.id as number);
    await this.storage.markReadingsSynced(ids);
    this.logger.log(`Synced ${ids.length} readings (batch ${batchId.slice(0, 8)})`);
  }
}
