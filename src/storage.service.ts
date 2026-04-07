import { Injectable, OnModuleInit } from '@nestjs/common';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { DB_FILE } from './config';
import { PULSE_ADDRESSES } from './modbus-map';
import { SnapshotValue } from './modbus.service';

type PulsePoint = {
  epoch_seconds: number;
  address: number;
  value_num: number;
};

@Injectable()
export class StorageService implements OnModuleInit {
  private db!: Database;
  private initPromise: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    await this.ensureReady();
  }

  private async ensureReady(): Promise<void> {
    if (this.db) {
      return;
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.db = await open({
          filename: DB_FILE,
          driver: sqlite3.Database,
        });

        await this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_iso TEXT NOT NULL,
        epoch_seconds INTEGER NOT NULL,
        address INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        value_text TEXT,
        value_num REAL
      );

      CREATE INDEX IF NOT EXISTS idx_readings_epoch ON readings(epoch_seconds);
      CREATE INDEX IF NOT EXISTS idx_readings_addr_epoch ON readings(address, epoch_seconds);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_iso TEXT NOT NULL,
        epoch_seconds INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT
      );
    `);
      })();
    }

    await this.initPromise;
  }

  async markEvent(eventType: string, details: string): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    await this.db.run(
      `INSERT INTO events(ts_iso, epoch_seconds, event_type, details) VALUES (?, ?, ?, ?)` ,
      new Date(now).toISOString(),
      Math.floor(now / 1000),
      eventType,
      details,
    );
  }

  async saveSnapshot(values: SnapshotValue[], tsIso: string, epochSeconds: number): Promise<void> {
    await this.ensureReady();
    await this.db.exec('BEGIN');
    try {
      for (const item of values) {
        const valueNum = typeof item.value === 'number' ? item.value : null;
        const valueText = typeof item.value === 'string' ? item.value : null;

        await this.db.run(
          `INSERT INTO readings(ts_iso, epoch_seconds, address, name, type, value_text, value_num)
           VALUES (?, ?, ?, ?, ?, ?, ?)` ,
          tsIso,
          epochSeconds,
          item.address,
          item.name,
          item.type,
          valueText,
          valueNum,
        );
      }
      await this.db.exec('COMMIT');
    } catch (error) {
      await this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getReadings(fromEpoch: number, toEpoch: number) {
    await this.ensureReady();
    return this.db.all(
      `SELECT ts_iso, epoch_seconds, address, name, type,
              COALESCE(CAST(value_num AS TEXT), value_text) AS value
       FROM readings
       WHERE epoch_seconds BETWEEN ? AND ?
       ORDER BY epoch_seconds ASC, address ASC`,
      fromEpoch,
      toEpoch,
    );
  }

  async getEvents(fromEpoch: number, toEpoch: number) {
    await this.ensureReady();
    return this.db.all(
      `SELECT ts_iso, epoch_seconds, event_type, details
       FROM events
       WHERE epoch_seconds BETWEEN ? AND ?
       ORDER BY epoch_seconds ASC`,
      fromEpoch,
      toEpoch,
    );
  }

  async analyzeInterval(fromEpoch: number, toEpoch: number) {
    await this.ensureReady();
    const placeholders = PULSE_ADDRESSES.map(() => '?').join(',');
    const rows = (await this.db.all(
      `SELECT epoch_seconds, address, value_num
       FROM readings
       WHERE epoch_seconds BETWEEN ? AND ?
         AND address IN (${placeholders})
         AND value_num IS NOT NULL
       ORDER BY epoch_seconds ASC, address ASC`,
      fromEpoch,
      toEpoch,
      ...PULSE_ADDRESSES,
    )) as PulsePoint[];

    const byEpoch = new Map<number, Map<number, number>>();
    for (const row of rows) {
      const map = byEpoch.get(row.epoch_seconds) ?? new Map<number, number>();
      map.set(row.address, row.value_num);
      byEpoch.set(row.epoch_seconds, map);
    }

    const epochs = [...byEpoch.keys()].sort((a, b) => a - b);
    if (epochs.length < 2) {
      return {
        fromEpoch,
        toEpoch,
        samples: epochs.length,
        message: 'No hay suficientes datos para analizar velocidad/paros.',
        overall: {
          stoppedSeconds: 0,
          lowSpeedSeconds: 0,
          avgSpeed: 0,
          minSpeed: 0,
          maxSpeed: 0,
        },
        byMachine: [],
      };
    }

    const perMachine = new Map<number, { deltas: Array<{ dt: number; d: number; speed: number }> }>();
    for (const addr of PULSE_ADDRESSES) {
      perMachine.set(addr, { deltas: [] });
    }

    const totalDeltas: Array<{ dt: number; d: number; speed: number }> = [];

    for (let i = 1; i < epochs.length; i++) {
      const prevEpoch = epochs[i - 1];
      const currEpoch = epochs[i];
      const prev = byEpoch.get(prevEpoch)!;
      const curr = byEpoch.get(currEpoch)!;
      const dt = Math.max(1, currEpoch - prevEpoch);

      let totalDelta = 0;
      for (const addr of PULSE_ADDRESSES) {
        const p = prev.get(addr);
        const c = curr.get(addr);
        if (p === undefined || c === undefined) {
          continue;
        }
        const d = c - p;
        totalDelta += d;

        perMachine.get(addr)!.deltas.push({
          dt,
          d,
          speed: d / dt,
        });
      }

      totalDeltas.push({
        dt,
        d: totalDelta,
        speed: totalDelta / dt,
      });
    }

    const summarize = (entries: Array<{ dt: number; d: number; speed: number }>) => {
      const positive = entries.filter((x) => x.speed > 0);
      const avgSpeed = positive.length > 0 ? positive.reduce((a, b) => a + b.speed, 0) / positive.length : 0;
      const threshold = avgSpeed * 0.6;

      let stoppedSeconds = 0;
      let lowSpeedSeconds = 0;
      for (const e of entries) {
        if (e.d <= 0) {
          stoppedSeconds += e.dt;
        } else if (avgSpeed > 0 && e.speed < threshold) {
          lowSpeedSeconds += e.dt;
        }
      }

      const speeds = entries.map((x) => x.speed);
      const minSpeed = speeds.length > 0 ? Math.min(...speeds) : 0;
      const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;

      return {
        stoppedSeconds,
        lowSpeedSeconds,
        avgSpeed: Number(avgSpeed.toFixed(3)),
        minSpeed: Number(minSpeed.toFixed(3)),
        maxSpeed: Number(maxSpeed.toFixed(3)),
      };
    };

    const byMachine = PULSE_ADDRESSES.map((address) => ({
      address,
      ...summarize(perMachine.get(address)!.deltas),
    }));

    return {
      fromEpoch,
      toEpoch,
      samples: epochs.length,
      overall: summarize(totalDeltas),
      byMachine,
    };
  }
}
