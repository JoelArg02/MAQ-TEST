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

type IntervalPoint = {
  from: number;
  to: number;
  dt: number;
  delta: number;
  speed: number;
};

type HourMachineAgg = {
  hour: string;
  weightedSpeed: number;
  seconds: number;
  sampledSeconds: number;
  validSampleSeconds: number;
  stoppedSeconds: number;
  resetSeconds: number;
  productionDelta: number;
};

type AnalysisMachine = {
  address: number;
  machine: string;
  machineType: 'TELAR' | 'CORTADORA';
  unit: 'metros' | 'costales';
};

const ANALYSIS_MACHINES: AnalysisMachine[] = [
  { address: 1100, machine: 'Telar 1', machineType: 'TELAR', unit: 'metros' },
  { address: 1110, machine: 'Telar 2', machineType: 'TELAR', unit: 'metros' },
  { address: 1120, machine: 'Telar 3', machineType: 'TELAR', unit: 'metros' },
  { address: 1030, machine: 'Cortadora 1', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1040, machine: 'Cortadora 2', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1050, machine: 'Cortadora 3', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1060, machine: 'Cortadora 4', machineType: 'CORTADORA', unit: 'costales' },
];

const EXPECTED_SAMPLE_SECONDS = 4;
const SAMPLE_MIN_SECONDS = 2;
const SAMPLE_MAX_SECONDS = 8;
const NO_CHANGE_GRACE_SECONDS = EXPECTED_SAMPLE_SECONDS * 2;

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

  async analyzeDayByHours(dayInput?: string) {
    await this.ensureReady();

    const baseDate = dayInput ? new Date(`${dayInput}T00:00:00`) : new Date();
    if (Number.isNaN(baseDate.getTime())) {
      throw new Error(`Fecha invalida: ${dayInput}`);
    }

    const dayStart = new Date(baseDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const fromEpoch = Math.floor(dayStart.getTime() / 1000);
    const toEpoch = Math.floor(dayEnd.getTime() / 1000);

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
        day: dayStart.toISOString().slice(0, 10),
        fromEpoch,
        toEpoch,
        noData: true,
        message: 'No hay datos',
        hourly: [],
        events: [],
        summary: {
          avgSpeed: 0,
          stoppedSeconds: 0,
          lowSpeedSeconds: 0,
        },
      };
    }

    const intervals: IntervalPoint[] = [];
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
        totalDelta += c - p;
      }

      intervals.push({
        from: prevEpoch,
        to: currEpoch,
        dt,
        delta: totalDelta,
        speed: totalDelta / dt,
      });
    }

    const positive = intervals.filter((x) => x.speed > 0);
    const avgSpeed = positive.length > 0 ? positive.reduce((a, b) => a + b.speed, 0) / positive.length : 0;
    const lowThreshold = avgSpeed * 0.6;
    const recoverThreshold = avgSpeed * 0.9;

    const toHourKey = (epoch: number) => {
      const d = new Date(epoch * 1000);
      return `${String(d.getHours()).padStart(2, '0')}:00`;
    };

    const hourAgg = new Map<string, { weightedSpeed: number; seconds: number; stopped: number; low: number }>();
    for (const it of intervals) {
      const key = toHourKey(it.from);
      const current = hourAgg.get(key) ?? { weightedSpeed: 0, seconds: 0, stopped: 0, low: 0 };
      current.weightedSpeed += it.speed * it.dt;
      current.seconds += it.dt;
      if (it.delta <= 0) {
        current.stopped += it.dt;
      } else if (avgSpeed > 0 && it.speed < lowThreshold) {
        current.low += it.dt;
      }
      hourAgg.set(key, current);
    }

    const hourly = [...hourAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, v]) => ({
        hour,
        avgSpeed: v.seconds > 0 ? Number((v.weightedSpeed / v.seconds).toFixed(3)) : 0,
        stoppedSeconds: v.stopped,
        lowSpeedSeconds: v.low,
      }));

    const events: Array<{ type: string; approxTime: string; epoch: number; detail: string }> = [];
    const toTimeText = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString();

    let state: 'stopped' | 'low' | 'normal' = 'normal';
    if (intervals[0].delta <= 0) {
      state = 'stopped';
    } else if (avgSpeed > 0 && intervals[0].speed < lowThreshold) {
      state = 'low';
    }

    for (let i = 1; i < intervals.length; i++) {
      const it = intervals[i];
      const previous = intervals[i - 1];

      const currentState: 'stopped' | 'low' | 'normal' =
        it.delta <= 0
          ? 'stopped'
          : avgSpeed > 0 && it.speed < lowThreshold
            ? 'low'
            : 'normal';

      if (state !== currentState) {
        if (state !== 'stopped' && currentState === 'stopped') {
          events.push({
            type: 'PARO_INICIO',
            approxTime: toTimeText(it.from),
            epoch: it.from,
            detail: 'Se detuvo la produccion (delta <= 0).',
          });
        }

        if (state === 'stopped' && currentState !== 'stopped') {
          events.push({
            type: 'PARO_FIN',
            approxTime: toTimeText(it.from),
            epoch: it.from,
            detail: 'Volvio a producir despues de paro.',
          });
        }

        if (state === 'normal' && currentState === 'low') {
          events.push({
            type: 'BAJA_VELOCIDAD',
            approxTime: toTimeText(it.from),
            epoch: it.from,
            detail: `Velocidad por debajo de ${lowThreshold.toFixed(3)}.`,
          });
        }

        if (state === 'low' && currentState === 'normal' && it.speed >= recoverThreshold) {
          events.push({
            type: 'SUBIDA_VELOCIDAD',
            approxTime: toTimeText(it.from),
            epoch: it.from,
            detail: `Recuperacion de velocidad por encima de ${recoverThreshold.toFixed(3)}.`,
          });
        }

        if (state === 'stopped' && currentState === 'low') {
          events.push({
            type: 'REINICIO_LENTO',
            approxTime: toTimeText(it.from),
            epoch: it.from,
            detail: 'Reinicio en velocidad baja.',
          });
        }

        state = currentState;
      }

      if (previous.speed > 0 && it.speed > previous.speed * 1.5 && it.speed >= recoverThreshold) {
        events.push({
          type: 'SUBIDA_BRUSCA',
          approxTime: toTimeText(it.from),
          epoch: it.from,
          detail: 'Subida brusca de velocidad respecto al tramo anterior.',
        });
      }

      if (previous.speed > 0 && it.speed < previous.speed * 0.6 && it.delta > 0) {
        events.push({
          type: 'BAJADA_BRUSCA',
          approxTime: toTimeText(it.from),
          epoch: it.from,
          detail: 'Bajada brusca de velocidad respecto al tramo anterior.',
        });
      }
    }

    let stoppedSeconds = 0;
    let lowSpeedSeconds = 0;
    for (const it of intervals) {
      if (it.delta <= 0) {
        stoppedSeconds += it.dt;
      } else if (avgSpeed > 0 && it.speed < lowThreshold) {
        lowSpeedSeconds += it.dt;
      }
    }

    return {
      day: dayStart.toISOString().slice(0, 10),
      fromEpoch,
      toEpoch,
      noData: false,
      message: '',
      summary: {
        avgSpeed: Number(avgSpeed.toFixed(3)),
        stoppedSeconds,
        lowSpeedSeconds,
      },
      hourly,
      events,
    };
  }

  async analyzeDayMachineTable(dayInput?: string) {
    await this.ensureReady();

    const baseDate = dayInput ? new Date(`${dayInput}T00:00:00`) : new Date();
    if (Number.isNaN(baseDate.getTime())) {
      throw new Error(`Fecha invalida: ${dayInput}`);
    }

    const dayStart = new Date(baseDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const fromEpoch = Math.floor(dayStart.getTime() / 1000);
    const toEpoch = Math.floor(dayEnd.getTime() / 1000);

    const analysisAddresses = ANALYSIS_MACHINES.map((m) => m.address);
    const placeholders = analysisAddresses.map(() => '?').join(',');
    const rows = (await this.db.all(
      `SELECT epoch_seconds, address, value_num
       FROM readings
       WHERE epoch_seconds BETWEEN ? AND ?
         AND address IN (${placeholders})
         AND value_num IS NOT NULL
       ORDER BY address ASC, epoch_seconds ASC`,
      fromEpoch,
      toEpoch,
      ...analysisAddresses,
    )) as PulsePoint[];

    if (rows.length === 0) {
      return {
        day: dayStart.toISOString().slice(0, 10),
        fromEpoch,
        toEpoch,
        noData: true,
        metric: {
          baselineWindowHours: 3,
          lowSpeedThresholdPct: -25,
          upSpeedThresholdPct: 25,
        },
        rows: [],
      };
    }

    const byAddress = new Map<number, PulsePoint[]>();
    for (const row of rows) {
      const list = byAddress.get(row.address) ?? [];
      list.push(row);
      byAddress.set(row.address, list);
    }

    const toHourKey = (epoch: number) => {
      const d = new Date(epoch * 1000);
      return `${String(d.getHours()).padStart(2, '0')}:00`;
    };

    const allRows: Array<{
      hour: string;
      machine: string;
      machineType: 'TELAR' | 'CORTADORA';
      unit: 'metros' | 'costales';
      avgSpeed: number;
      productionInHour: number;
      stoppedSeconds: number;
      resetSeconds: number;
      dataQualityPct: number;
      baselineAvgSpeed: number | null;
      changeVsBaselinePct: number | null;
      changeVsPrevHourPct: number | null;
      trend: 'PARO' | 'BAJO_VELOCIDAD' | 'SUBIO_VELOCIDAD' | 'ESTABLE' | 'SIN_REFERENCIA';
      insight: string;
    }> = [];

    for (const machine of ANALYSIS_MACHINES) {
      const points = byAddress.get(machine.address) ?? [];
      if (points.length < 2) {
        continue;
      }

      const byHour = new Map<string, HourMachineAgg>();
      let noChangeStreakSeconds = 0;
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const dt = Math.max(1, curr.epoch_seconds - prev.epoch_seconds);
        const rawDelta = curr.value_num - prev.value_num;
        const delta = rawDelta < 0 ? 0 : rawDelta;
        const speed = delta / dt;

        const hour = toHourKey(prev.epoch_seconds);
        const agg = byHour.get(hour) ?? {
          hour,
          weightedSpeed: 0,
          seconds: 0,
          sampledSeconds: 0,
          validSampleSeconds: 0,
          stoppedSeconds: 0,
          resetSeconds: 0,
          productionDelta: 0,
        };

        agg.weightedSpeed += speed * dt;
        agg.seconds += dt;
        agg.sampledSeconds += dt;
        if (dt >= SAMPLE_MIN_SECONDS && dt <= SAMPLE_MAX_SECONDS) {
          agg.validSampleSeconds += dt;
        }
        agg.productionDelta += delta;

        if (rawDelta < 0) {
          agg.resetSeconds += dt;
          noChangeStreakSeconds = 0;
        } else if (delta <= 0) {
          noChangeStreakSeconds += dt;
          if (noChangeStreakSeconds > NO_CHANGE_GRACE_SECONDS) {
            agg.stoppedSeconds += dt;
          }
        } else {
          noChangeStreakSeconds = 0;
        }

        byHour.set(hour, agg);
      }

      const hourly = [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));

      for (let i = 0; i < hourly.length; i++) {
        const current = hourly[i];
        const avgSpeed = current.seconds > 0 ? current.weightedSpeed / current.seconds : 0;
        const dataQualityPct =
          current.sampledSeconds > 0
            ? (current.validSampleSeconds / current.sampledSeconds) * 100
            : 0;

        const prevHours = hourly.slice(Math.max(0, i - 3), i);
        const baselineCandidates = prevHours
          .map((x) => (x.seconds > 0 ? x.weightedSpeed / x.seconds : 0))
          .filter((x) => x > 0);

        const baselineAvgSpeed =
          baselineCandidates.length > 0
            ? baselineCandidates.reduce((sum, x) => sum + x, 0) / baselineCandidates.length
            : null;

        const prevHourAvg =
          i > 0 && hourly[i - 1].seconds > 0
            ? hourly[i - 1].weightedSpeed / hourly[i - 1].seconds
            : null;

        const changeVsBaselinePct =
          baselineAvgSpeed && baselineAvgSpeed > 0
            ? ((avgSpeed - baselineAvgSpeed) / baselineAvgSpeed) * 100
            : null;

        const changeVsPrevHourPct =
          prevHourAvg && prevHourAvg > 0
            ? ((avgSpeed - prevHourAvg) / prevHourAvg) * 100
            : null;

        let trend: 'PARO' | 'BAJO_VELOCIDAD' | 'SUBIO_VELOCIDAD' | 'ESTABLE' | 'SIN_REFERENCIA' =
          'SIN_REFERENCIA';

        if (current.seconds > 0 && current.stoppedSeconds / current.seconds >= 0.8) {
          trend = 'PARO';
        } else if (changeVsBaselinePct === null) {
          trend = 'SIN_REFERENCIA';
        } else if (changeVsBaselinePct <= -25) {
          trend = 'BAJO_VELOCIDAD';
        } else if (changeVsBaselinePct >= 25) {
          trend = 'SUBIO_VELOCIDAD';
        } else {
          trend = 'ESTABLE';
        }

        const insight =
          trend === 'PARO'
            ? `Paro dominante (${current.stoppedSeconds}s detenida en la hora).`
            : trend === 'BAJO_VELOCIDAD'
              ? `Bajo velocidad ${Number(changeVsBaselinePct!.toFixed(1))}% vs baseline de horas previas.`
              : trend === 'SUBIO_VELOCIDAD'
                ? `Subio velocidad ${Number(changeVsBaselinePct!.toFixed(1))}% vs baseline de horas previas.`
                : trend === 'ESTABLE'
                  ? 'Comportamiento estable respecto a horas previas.'
                  : 'Sin historial suficiente para comparar.';

        allRows.push({
          hour: current.hour,
          machine: machine.machine,
          machineType: machine.machineType,
          unit: machine.unit,
          avgSpeed: Number(avgSpeed.toFixed(3)),
          productionInHour: Number(current.productionDelta.toFixed(3)),
          stoppedSeconds: current.stoppedSeconds,
          resetSeconds: current.resetSeconds,
          dataQualityPct: Number(dataQualityPct.toFixed(1)),
          baselineAvgSpeed:
            baselineAvgSpeed === null ? null : Number(baselineAvgSpeed.toFixed(3)),
          changeVsBaselinePct:
            changeVsBaselinePct === null ? null : Number(changeVsBaselinePct.toFixed(1)),
          changeVsPrevHourPct:
            changeVsPrevHourPct === null ? null : Number(changeVsPrevHourPct.toFixed(1)),
          trend,
          insight,
        });
      }
    }

    allRows.sort((a, b) => {
      const byHour = a.hour.localeCompare(b.hour);
      if (byHour !== 0) {
        return byHour;
      }
      return a.machine.localeCompare(b.machine);
    });

    return {
      day: dayStart.toISOString().slice(0, 10),
      fromEpoch,
      toEpoch,
      noData: allRows.length === 0,
      metric: {
        baselineWindowHours: 3,
        lowSpeedThresholdPct: -25,
        upSpeedThresholdPct: 25,
      },
      columns: [
        'hour',
        'machine',
        'avgSpeed',
        'productionInHour',
        'stoppedSeconds',
        'trend',
      ],
      rows: allRows,
    };
  }
}
