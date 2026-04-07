# Plan de Implementación: Sync Local → API-SACOS-GALLARDO

## Arquitectura Híbrida

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│   LAPTOP (MAQ-TEST)      │  HTTP   │  HEROKU (API-SACOS-GALLARDO) │
│                          │ ─────►  │                              │
│  PLC ← Modbus 1s        │  cada   │  SQL Server                  │
│  SQLite (buffer local)   │  5s     │  Tablas Producción           │
│  NestJS :5434            │  batch  │  .NET 10 API                 │
│                          │         │  Análisis + Dashboard Web    │
└──────────────────────────┘         └──────────────────────────────┘
```

---

## Estrategia Anti-Pérdida de Datos

1. Local lee PLC cada 1s → guarda en SQLite **(siempre, sin importar internet)**
2. Cada 5s: intenta enviar batch de lecturas **NO sincronizadas**
3. Si éxito → marca como `synced = 1` en SQLite
4. Si falla (sin internet) → se acumulan, reintentan al siguiente ciclo
5. Cuando vuelve internet → envía todo el backlog automáticamente

---

## Nuevas Tablas en SQL Server (API-SACOS-GALLARDO)

### Tabla: `Machine`

| Columna     | Tipo           | Descripción                              |
|-------------|----------------|------------------------------------------|
| Id          | Guid, PK       | Identificador único                      |
| Address     | int, unique     | Dirección Modbus (D1000, D1100, etc.)    |
| Name        | string          | "Telar 1", "Cortadora 2", etc.           |
| MachineType | enum            | Telar, Cortadora                         |
| Unit        | string          | "metros" o "costales"                    |
| Status      | GenericStatus   | Active / Inactive                        |
| CreatedAt   | DateTime        | Fecha de creación                        |
| UpdatedAt   | DateTime        | Última actualización                     |

### Tabla: `MachineReading`

| Columna      | Tipo           | Descripción                                  |
|--------------|----------------|----------------------------------------------|
| Id           | long, PK       | Auto-incremental                             |
| MachineId    | Guid, FK       | → Machine                                    |
| EpochSeconds | long, indexed   | Timestamp UNIX del PLC                       |
| Address      | int            | Dirección Modbus                             |
| Name         | string          | Nombre del registro                          |
| ValueType    | string          | "UINT16", "INT16", etc.                      |
| ValueNum     | double?         | Valor numérico                               |
| ValueText    | string?         | Valor texto (si aplica)                      |
| CapturedAt   | DateTime        | Timestamp original del PLC                   |
| ReceivedAt   | DateTime        | Cuando llegó al backend                      |
| BatchId      | Guid            | Agrupa lecturas del mismo envío              |

> **UNIQUE INDEX:** `(Address, EpochSeconds)` — evita duplicados si se reenvía el mismo batch

### Tabla: `ProductionEvent`

| Columna      | Tipo           | Descripción                                  |
|--------------|----------------|----------------------------------------------|
| Id           | Guid, PK       | Identificador único                          |
| EpochSeconds | long            | Timestamp UNIX                               |
| EventType    | string          | SYSTEM_START, RESET, CAPTURE_ERROR, etc.     |
| Details      | string          | Información adicional                        |
| ReceivedAt   | DateTime        | Cuando llegó al backend                      |

### Tabla: `ProductionAnomaly`

| Columna       | Tipo           | Descripción                                 |
|---------------|----------------|---------------------------------------------|
| Id            | Guid, PK       | Identificador único                         |
| MachineId     | Guid, FK       | → Machine                                   |
| EpochSeconds  | long            | Timestamp UNIX                              |
| AnomalyType   | string          | PICO_VELOCIDAD, CAIDA_VELOCIDAD, PARO_ANOMALO |
| Severity      | string          | MEDIA, ALTA, CRITICA                        |
| SpeedObserved | double          | Velocidad observada                         |
| SpeedEwma     | double          | Velocidad EWMA de referencia                |
| ZScore        | double          | Z-score calculado                           |
| SigmaMad      | double          | Sigma MAD                                   |
| Details       | string          | Detalles del cálculo                        |
| DetectedAt    | DateTime        | Cuando se detectó                           |

> **UNIQUE INDEX:** `(MachineId, EpochSeconds)` — evita duplicados

---

## Endpoint de Ingesta en .NET (nuevo)

```
POST /api/production/ingest
Authorization: Bearer <JWT o API Key>

Body:
{
  "batchId": "guid",
  "capturedAt": "2026-04-06T10:00:00Z",
  "readings": [
    {
      "address": 1100,
      "name": "Metros Tejidos T1",
      "type": "UINT16",
      "epochSeconds": 1743937200,
      "valueNum": 42.0
    },
    ...
  ],
  "events": [
    {
      "epochSeconds": 1743937200,
      "eventType": "SYSTEM_START",
      "details": "..."
    }
  ]
}

Response:
{
  "accepted": 17,
  "duplicates": 0,
  "batchId": "guid"
}
```

---

## Cambio en MAQ-TEST (NestJS local)

### SQLite: nueva columna

```sql
ALTER TABLE readings ADD COLUMN synced INTEGER DEFAULT 0;
```

### Nuevo `SyncService`

```
Cada 5 segundos:
  1. SELECT * FROM readings WHERE synced = 0 LIMIT 200
  2. POST /api/production/ingest al backend .NET con el batch
  3. Si respuesta 200 → UPDATE readings SET synced = 1 WHERE id IN (...)
  4. Si falla → log warning, reintenta en el siguiente ciclo

Backlog máximo por día: 86,400 snapshots × 17 addresses = ~1.4M filas
(SQLite maneja esto sin problema)
```

---

## Garantías de Datos Fidedignos

| Riesgo                          | Mitigación                                              |
|---------------------------------|---------------------------------------------------------|
| Internet se cae 2 horas         | SQLite buffer acumula, sync cuando vuelve               |
| Backend rechaza duplicados      | `UNIQUE(Address, EpochSeconds)` + `INSERT OR IGNORE`    |
| Laptop se apaga                 | Al reiniciar, `synced=0` siguen ahí, se envían          |
| Datos llegan desordenados       | `EpochSeconds` como fuente de verdad temporal            |
| Pérdida total de laptop         | Los datos ya sincronizados están seguros en SQL Server   |
| Batch parcialmente enviado      | `BatchId` permite idempotencia — reenviar sin duplicar   |

---

## Frecuencia Recomendada

| Operación            | Frecuencia | Justificación                                  |
|----------------------|------------|------------------------------------------------|
| Lectura PLC          | 1s         | Se queda igual, es la fuente de verdad         |
| Sync a Heroku        | 5s         | Batch de ~85 lecturas (5s × 17 addresses)      |
| Análisis en .NET     | 60s        | Bajo demanda o periódico, no cada segundo      |

---

## Orden de Implementación

### Fase 1: Backend .NET (API-SACOS-GALLARDO)

1. Entidades: `Machine`, `MachineReading`, `ProductionEvent`, `ProductionAnomaly`
2. Migración EF Core
3. Puerto Inbound: `IIngestProductionDataUseCase`
4. UseCase + DTOs
5. `ProductionController` con `POST /api/production/ingest`
6. Auth: API Key o cuenta de servicio dedicada para el sync

### Fase 2: NestJS local (MAQ-TEST)

7. Columna `synced` en SQLite
8. `SyncService` con retry y backlog
9. Mover análisis pesado (`analyzeDayMachineTable`) al backend .NET

### Fase 3: Validación

10. Simular corte de internet → verificar que backlog se acumula
11. Reconectar → verificar que backlog se envía completo
12. Verificar que no hay duplicados en SQL Server
13. Verificar que el análisis en .NET produce los mismos resultados
