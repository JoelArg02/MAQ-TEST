export const IP_PLC = process.env.PLC_IP ?? '192.168.100.64';
export const PLC_PORT = Number(process.env.PLC_PORT ?? 502);
export const PLC_SLAVE_ID = Number(process.env.PLC_SLAVE_ID ?? 1);
export const PLC_TIMEOUT_MS = Number(process.env.PLC_TIMEOUT_MS ?? 3000);
export const HTTP_PORT = Number(process.env.PORT ?? 5434);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
export const DB_FILE = process.env.DB_FILE ?? 'modbus_history.db';

export const SYNC_API_URL = process.env.SYNC_API_URL ?? '';
export const KEY_BACK = process.env.KEY_BACK ?? '';
export const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 5000);
export const SYNC_BATCH_SIZE = Number(process.env.SYNC_BATCH_SIZE ?? 200);
