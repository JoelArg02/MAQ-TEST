export const IP_PLC = process.env.PLC_IP ?? '192.168.100.64';
export const PLC_PORT = Number(process.env.PLC_PORT ?? 502);
export const PLC_SLAVE_ID = Number(process.env.PLC_SLAVE_ID ?? 1);
export const PLC_TIMEOUT_MS = Number(process.env.PLC_TIMEOUT_MS ?? 3000);
export const HTTP_PORT = Number(process.env.PORT ?? 5434);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000);
export const DB_FILE = process.env.DB_FILE ?? 'modbus_history.db';
