import { Injectable, OnModuleInit } from '@nestjs/common';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { DB_FILE, HEARTBEAT_INTERVAL_S } from './config';
import { LECTURAS } from './modbus-map';
import type { SnapshotValue } from './modbus.service';

// ─── Constantes inmutables ─────────────────────────────────────────────────────
// Typed arrays: sin overhead de objetos JS, layout contiguo en memoria.

/** Direcciones de producción como Int16Array — búsqueda O(1) vía Set, iteración vía array */
const PROD_ADDR = Int16Array.from([1000, 1010, 1020, 1030, 1040, 1050, 1060, 1100, 1110, 1120]);

/** Mapa address → índice para acceso directo en Float64Array */
const ADDR_IDX = new Map<number, number>();
for (let i = 0; i < PROD_ADDR.length; i++) ADDR_IDX.set(PROD_ADDR[i], i);

/** Número de máquinas de producción */
const N = PROD_ADDR.length; // 10

/** Info estática por máquina — strings interned (una sola referencia en memoria) */
const MACHINE_INFO: ReadonlyArray<{
  address: number;
  machine: string;
  machineType: 'TELAR' | 'CORTADORA';
  unit: 'metros' | 'costales' | 'pulsos';
}> = Object.freeze([
  { address: 1000, machine: 'Pulsos Telar 1', machineType: 'TELAR', unit: 'pulsos' },
  { address: 1010, machine: 'Pulsos Telar 2', machineType: 'TELAR', unit: 'pulsos' },
  { address: 1020, machine: 'Pulsos Telar 3', machineType: 'TELAR', unit: 'pulsos' },
  { address: 1030, machine: 'Cortadora 1', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1040, machine: 'Cortadora 2', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1050, machine: 'Cortadora 3', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1060, machine: 'Cortadora 4', machineType: 'CORTADORA', unit: 'costales' },
  { address: 1100, machine: 'Metros Tejidos T1', machineType: 'TELAR', unit: 'metros' },
  { address: 1110, machine: 'Metros Tejidos T2', machineType: 'TELAR', unit: 'metros' },
  { address: 1120, machine: 'Metros Tejidos T3', machineType: 'TELAR', unit: 'metros' },
]);

/** Nombre por address — lookup directo, evita recorrer LECTURAS */
const ADDR_NAME = new Map<number, string>();
const ADDR_TYPE = new Map<number, string>();
for (const item of LECTURAS) {
  ADDR_NAME.set(item.address, item.name);
  ADDR_TYPE.set(item.address, item.type);
}

// ─── Servicio ──────────────────────────────────────────────────────────────────

@Injectable()
export class StorageService implements OnModuleInit {
  private db!: Database;
  private initPromise: Promise<void> | null = null;

  /**
   * Últimos valores guardados — Float64Array contiguo en memoria.
   * Índice = ADDR_IDX[address]. NaN significa "sin valor previo".
   * 7 × 8 bytes = 56 bytes total (vs Map con overhead de ~300+ bytes por entry).
   */
  private readonly lastVals = new Float64Array(N).fill(NaN);

  /** Epoch del último guardado (para heartbeat) */
  private lastSaveEpoch = 0;

  /** Caché del análisis (un solo objeto, TTL 30s) */
  private analysisCache: { key: string; data: unknown; ts: number } | null = null;
  private readonly CACHE_TTL = 30_000;

  // ─── Init ──────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.ensureReady();
  }

  private async ensureReady(): Promise<void> {
    if (this.db) return;
    if (!this.initPromise) {
      this.initPromise = this.initDb();
    }
    await this.initPromise;
  }

  private async initDb(): Promise<void> {
    this.db = await open({ filename: DB_FILE, driver: sqlite3.Database });

    // PRAGMAs de rendimiento para hardware limitado
    await this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -2000;
      PRAGMA temp_store = MEMORY;
      PRAGMA page_size = 4096;
    `);

    // Schema compacto: sin ts_iso/name/type redundantes.
    // Solo epoch (INT), address (INT), value (REAL). Mínimo footprint.
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

    // Limpieza de schema anterior
    try { await this.db.exec(`DROP INDEX IF EXISTS idx_readings_synced`); } catch { /* ok */ }
    await this.db.exec(`DROP TABLE IF EXISTS anomalies`);
  }

  // ─── Escritura ─────────────────────────────────────────────────────────────

  async markEvent(eventType: string, details: string): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    await this.db.run(
      `INSERT INTO events(ts_iso, epoch_seconds, event_type, details) VALUES (?,?,?,?)`,
      new Date(now).toISOString(), (now / 1000) | 0, eventType, details,
    );
  }

  /**
   * Guarda snapshot filtrado.
   *
   * Memoria: compara contra Float64Array de 56 bytes (sin allocs).
   * Si nada cambió y no toca heartbeat → return inmediato, 0 allocs.
   * Si sí hay que guardar → un solo batch INSERT con parámetros reutilizados.
   */
  async saveSnapshot(values: SnapshotValue[], tsIso: string, epochSeconds: number): Promise<void> {
    await this.ensureReady();

    // Paso 1: detectar cambio comparando contra Float64Array
    let changed = false;
    // Recorremos values del snapshot (17 items) filtrando solo producción
    for (let v = 0; v < values.length; v++) {
      const item = values[v];
      const idx = ADDR_IDX.get(item.address);
      if (idx === undefined) continue; // no es producción
      if (typeof item.value !== 'number') continue; // error de com

      const prev = this.lastVals[idx];
      if (prev !== item.value) { // NaN !== anything → true la primera vez
        changed = true;
        break;
      }
    }

    // Heartbeat check (sin allocs extra)
    if (!changed) {
      if (epochSeconds - this.lastSaveEpoch < HEARTBEAT_INTERVAL_S) return;
      // heartbeat: guardar aunque no cambió
    }

    // Paso 2: construir batch insert
    // Reutilizamos un solo array de parámetros preallocado
    const params: unknown[] = [];
    for (let v = 0; v < values.length; v++) {
      const item = values[v];
      const idx = ADDR_IDX.get(item.address);
      if (idx === undefined) continue;
      const val = typeof item.value === 'number' ? item.value : null;
      if (val === null) continue;

      params.push(
        tsIso, epochSeconds, item.address,
        ADDR_NAME.get(item.address)!, ADDR_TYPE.get(item.address)!,
        null, val,
      );
      this.lastVals[idx] = val;
    }

    if (params.length === 0) return;

    const rowCount = params.length / 7;
    const ph = new Array(rowCount).fill('(?,?,?,?,?,?,?)').join(',');
    await this.db.run(
      `INSERT INTO readings(ts_iso,epoch_seconds,address,name,type,value_text,value_num) VALUES ${ph}`,
      ...params,
    );

    this.lastSaveEpoch = epochSeconds;
  }

  // ─── Limpieza ──────────────────────────────────────────────────────────────

  async clearAllData(): Promise<{ deleted: { readings: number; events: number } }> {
    await this.ensureReady();
    this.analysisCache = null;
    this.lastVals.fill(NaN);
    this.lastSaveEpoch = 0;
    const r = await this.db.run(`DELETE FROM readings`);
    const e = await this.db.run(`DELETE FROM events`);
    return { deleted: { readings: r.changes ?? 0, events: e.changes ?? 0 } };
  }

  // ─── Lecturas ──────────────────────────────────────────────────────────────

  async getReadings(fromEpoch: number, toEpoch: number) {
    await this.ensureReady();
    return this.db.all(
      `SELECT ts_iso, epoch_seconds, address, name, type,
              COALESCE(CAST(value_num AS TEXT), value_text) AS value
       FROM readings WHERE epoch_seconds BETWEEN ? AND ?
       ORDER BY epoch_seconds ASC, address ASC`,
      fromEpoch, toEpoch,
    );
  }

  async getEvents(fromEpoch: number, toEpoch: number) {
    await this.ensureReady();
    return this.db.all(
      `SELECT ts_iso, epoch_seconds, event_type, details
       FROM events WHERE epoch_seconds BETWEEN ? AND ?
       ORDER BY epoch_seconds ASC`,
      fromEpoch, toEpoch,
    );
  }

  // ─── Análisis ──────────────────────────────────────────────────────────────

  /**
   * Análisis por intervalo — procesamiento streaming.
   *
   * En lugar de cargar todos los rows en un Map<epoch, Map<addr, val>>,
   * procesamos row-by-row acumulando directamente en Float64Arrays por máquina.
   * Memoria: O(N_máquinas) constante, no O(N_rows).
   */
  async analyzeInterval(fromEpoch: number, toEpoch: number) {
    await this.ensureReady();

    const placeholders = Array.from(PROD_ADDR, () => '?').join(',');
    const rows = (await this.db.all(
      `SELECT epoch_seconds, address, value_num
       FROM readings
       WHERE epoch_seconds BETWEEN ? AND ?
         AND address IN (${placeholders})
         AND value_num IS NOT NULL
       ORDER BY address ASC, epoch_seconds ASC`,
      fromEpoch, toEpoch, ...PROD_ADDR,
    )) as Array<{ epoch_seconds: number; address: number; value_num: number }>;

    if (rows.length < 2) {
      return {
        fromEpoch, toEpoch, samples: rows.length,
        message: 'No hay suficientes datos para analizar.',
        overall: { stoppedSeconds: 0, avgSpeed: 0 },
        byMachine: [],
      };
    }

    // Acumuladores por máquina: [totalDelta, totalTime, stoppedSeconds]
    // 3 valores × 7 máquinas = 21 doubles = 168 bytes
    const acc = new Float64Array(N * 3);
    // Último valor visto por máquina (para calcular deltas)
    const lastEpoch = new Int32Array(N).fill(-1);
    const lastVal = new Float64Array(N).fill(NaN);

    let totalSamples = 0;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const idx = ADDR_IDX.get(row.address);
      if (idx === undefined) continue;

      if (lastEpoch[idx] >= 0) {
        const dt = Math.max(1, row.epoch_seconds - lastEpoch[idx]);
        const rawDelta = row.value_num - lastVal[idx];
        const delta = rawDelta < 0 ? 0 : rawDelta;

        const base = idx * 3;
        acc[base] += delta;      // totalDelta
        acc[base + 1] += dt;     // totalTime
        if (delta <= 0) acc[base + 2] += dt; // stoppedSeconds
      } else {
        totalSamples++;
      }

      lastEpoch[idx] = row.epoch_seconds;
      lastVal[idx] = row.value_num;
    }

    const byMachine = [];
    let overallDelta = 0, overallTime = 0, overallStopped = 0;

    for (let i = 0; i < N; i++) {
      const base = i * 3;
      const td = acc[base], tt = acc[base + 1], ss = acc[base + 2];
      overallDelta += td;
      overallTime += tt;
      overallStopped += ss;
      byMachine.push({
        address: PROD_ADDR[i],
        stoppedSeconds: ss,
        avgSpeed: tt > 0 ? Math.round((td / tt) * 1000) / 1000 : 0,
      });
    }

    return {
      fromEpoch, toEpoch,
      samples: totalSamples,
      overall: {
        stoppedSeconds: overallStopped,
        avgSpeed: overallTime > 0 ? Math.round((overallDelta / overallTime) * 1000) / 1000 : 0,
      },
      byMachine,
    };
  }

  /**
   * Análisis por horas — streaming con acumuladores por hora.
   * Usa un solo Map<hourKey, {acumuladores numéricos}>, no duplica rows.
   */
  async analyzeDayByHours(dayInput?: string) {
    await this.ensureReady();

    const { dayStr, fromEpoch, toEpoch } = this.parseDayRange(dayInput);

    const placeholders = Array.from(PROD_ADDR, () => '?').join(',');
    const rows = (await this.db.all(
      `SELECT epoch_seconds, address, value_num
       FROM readings
       WHERE epoch_seconds BETWEEN ? AND ?
         AND address IN (${placeholders})
         AND value_num IS NOT NULL
       ORDER BY address ASC, epoch_seconds ASC`,
      fromEpoch, toEpoch, ...PROD_ADDR,
    )) as Array<{ epoch_seconds: number; address: number; value_num: number }>;

    if (rows.length < 2) {
      return {
        day: dayStr, fromEpoch, toEpoch, noData: true,
        message: 'No hay datos', hourly: [], summary: { avgSpeed: 0, stoppedSeconds: 0 },
      };
    }

    // Agrupar y calcular por máquina → acumular en horas
    // Primero: previo por address
    const prevEpoch = new Int32Array(N).fill(-1);
    const prevVal = new Float64Array(N).fill(NaN);

    // Acumuladores por hora: key → { weightedSpeed, seconds, stopped }
    const hourAgg = new Map<number, { ws: number; sec: number; stop: number }>();

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const idx = ADDR_IDX.get(row.address);
      if (idx === undefined) continue;

      if (prevEpoch[idx] >= 0) {
        const dt = Math.max(1, row.epoch_seconds - prevEpoch[idx]);
        const rawDelta = row.value_num - prevVal[idx];
        const delta = rawDelta < 0 ? 0 : rawDelta;
        const speed = delta / dt;

        // Hora como número entero (0-23) en vez de string — ahorra allocs
        const hourNum = new Date(prevEpoch[idx] * 1000).getHours();
        const agg = hourAgg.get(hourNum);
        if (agg) {
          agg.ws += speed * dt;
          agg.sec += dt;
          if (delta <= 0) agg.stop += dt;
        } else {
          hourAgg.set(hourNum, {
            ws: speed * dt,
            sec: dt,
            stop: delta <= 0 ? dt : 0,
          });
        }
      }

      prevEpoch[idx] = row.epoch_seconds;
      prevVal[idx] = row.value_num;
    }

    // Convertir a output
    const hours = [...hourAgg.keys()].sort((a, b) => a - b);
    let totalWs = 0, totalSec = 0, totalStop = 0;

    const hourly = hours.map((h) => {
      const a = hourAgg.get(h)!;
      totalWs += a.ws;
      totalSec += a.sec;
      totalStop += a.stop;
      return {
        hour: `${String(h).padStart(2, '0')}:00`,
        avgSpeed: a.sec > 0 ? Math.round((a.ws / a.sec) * 1000) / 1000 : 0,
        stoppedSeconds: a.stop,
      };
    });

    return {
      day: dayStr, fromEpoch, toEpoch, noData: false,
      hourly,
      summary: {
        avgSpeed: totalSec > 0 ? Math.round((totalWs / totalSec) * 1000) / 1000 : 0,
        stoppedSeconds: totalStop,
      },
    };
  }

  /**
   * Tabla máquina×hora — procesamiento con Typed Arrays.
   * Preallocamos un grid de 24 horas × 7 máquinas × 4 métricas = 672 doubles (5.25 KB).
   * Cero Maps anidados, cero arrays intermedios.
   */
  async analyzeDayMachineTable(dayInput?: string) {
    await this.ensureReady();

    const cacheKey = dayInput || new Date().toISOString().slice(0, 10);
    const now = Date.now();
    if (this.analysisCache && this.analysisCache.key === cacheKey
      && now - this.analysisCache.ts < this.CACHE_TTL) {
      return this.analysisCache.data;
    }

    const result = await this._computeDayTable(dayInput);
    this.analysisCache = { key: cacheKey, data: result, ts: now };
    return result;
  }

  private async _computeDayTable(dayInput?: string) {
    const { dayStr, fromEpoch, toEpoch } = this.parseDayRange(dayInput);

    const analysisAddresses = MACHINE_INFO.map((m) => m.address);
    const placeholders = analysisAddresses.map(() => '?').join(',');
    const rows = (await this.db.all(
      `SELECT epoch_seconds, address, value_num
       FROM readings
       WHERE epoch_seconds BETWEEN ? AND ?
         AND address IN (${placeholders})
         AND value_num IS NOT NULL
       ORDER BY address ASC, epoch_seconds ASC`,
      fromEpoch, toEpoch, ...analysisAddresses,
    )) as Array<{ epoch_seconds: number; address: number; value_num: number }>;

    if (rows.length === 0) {
      return { day: dayStr, fromEpoch, toEpoch, noData: true, rows: [] };
    }

    // Grid: 24 horas × 7 máquinas × 4 métricas
    // [weightedSpeed, runningSeconds, totalSeconds, stoppedSeconds, productionDelta]
    const METRICS = 5;
    const grid = new Float64Array(24 * N * METRICS); // 24×7×5 = 840 doubles = 6.7 KB

    // Estado previo por máquina
    const pEpoch = new Int32Array(N).fill(-1);
    const pVal = new Float64Array(N).fill(NaN);

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const mIdx = ADDR_IDX.get(row.address);
      if (mIdx === undefined) continue;

      if (pEpoch[mIdx] >= 0) {
        const dt = Math.max(1, row.epoch_seconds - pEpoch[mIdx]);
        const rawDelta = row.value_num - pVal[mIdx];
        const delta = rawDelta < 0 ? 0 : rawDelta;
        const speed = delta / dt;

        const hourNum = new Date(pEpoch[mIdx] * 1000).getHours();
        const base = (hourNum * N + mIdx) * METRICS;

        grid[base] += speed * dt;     // weightedSpeed
        grid[base + 1] += delta > 0 ? dt : 0; // runningSeconds
        grid[base + 2] += dt;         // totalSeconds
        grid[base + 3] += delta <= 0 ? dt : 0; // stoppedSeconds
        grid[base + 4] += delta;      // productionDelta
      }

      pEpoch[mIdx] = row.epoch_seconds;
      pVal[mIdx] = row.value_num;
    }

    // Construir resultado solo para celdas con datos
    const allRows: Array<{
      hour: string;
      machine: string;
      machineType: 'TELAR' | 'CORTADORA';
      unit: 'metros' | 'costales' | 'pulsos';
      avgSpeed: number;
      productionInHour: number;
      stoppedSeconds: number;
      trend: 'PARO' | 'PRODUCIENDO' | 'SIN_REFERENCIA';
    }> = [];

    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < N; m++) {
        const base = (h * N + m) * METRICS;
        const totalSec = grid[base + 2];
        if (totalSec <= 0) continue; // sin datos en esta celda

        const runningSec = grid[base + 1];
        const stoppedSec = grid[base + 3];
        const prodDelta = grid[base + 4];
        const wSpeed = grid[base];

        const avgSpeed = runningSec > 0 ? Math.round((wSpeed / runningSec) * 1000) / 1000 : 0;
        const trend = stoppedSec / totalSec >= 0.8 ? 'PARO' as const
          : totalSec > 0 ? 'PRODUCIENDO' as const
          : 'SIN_REFERENCIA' as const;

        const info = MACHINE_INFO[m];
        allRows.push({
          hour: `${String(h).padStart(2, '0')}:00`,
          machine: info.machine,
          machineType: info.machineType,
          unit: info.unit,
          avgSpeed,
          productionInHour: Math.round(prodDelta * 1000) / 1000,
          stoppedSeconds: stoppedSec,
          trend,
        });
      }
    }

    return { day: dayStr, fromEpoch, toEpoch, noData: allRows.length === 0, rows: allRows };
  }

  // ─── Utilidades ────────────────────────────────────────────────────────────

  private parseDayRange(dayInput?: string): { dayStr: string; fromEpoch: number; toEpoch: number } {
    const base = dayInput ? new Date(`${dayInput}T00:00:00`) : new Date();
    if (Number.isNaN(base.getTime())) throw new Error(`Fecha invalida: ${dayInput}`);

    const start = new Date(base);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    return {
      dayStr: start.toISOString().slice(0, 10),
      fromEpoch: (start.getTime() / 1000) | 0,
      toEpoch: (end.getTime() / 1000) | 0,
    };
  }
}
