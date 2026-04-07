export type ValueType = 'int32' | 'float32';

export type ReadItem = {
  address: number;
  name: string;
  type: ValueType;
};

export type PulsosTarget = {
  address: number;
  name: string;
};

export type PerimetroTarget = {
  address: number;
  name: string;
};

export const LECTURAS: ReadItem[] = [
  { address: 1000, name: 'Pulsos Telar 1', type: 'int32' },
  { address: 1010, name: 'Pulsos Telar 2', type: 'int32' },
  { address: 1020, name: 'Pulsos Telar 3', type: 'int32' },
  { address: 1030, name: 'Pulsos Cortadora 1', type: 'int32' },
  { address: 1040, name: 'Pulsos Cortadora 2', type: 'int32' },
  { address: 1050, name: 'Pulsos Cortadora 3', type: 'int32' },
  { address: 1060, name: 'Pulsos Cortadora 4', type: 'int32' },
  { address: 1070, name: 'Perimetro Rodillo 1', type: 'float32' },
  { address: 1080, name: 'Perimetro Rodillo 2', type: 'float32' },
  { address: 1090, name: 'Perimetro Rodillo 3', type: 'float32' },
  { address: 1100, name: 'Metros Tejidos T1', type: 'float32' },
  { address: 1110, name: 'Metros Tejidos T2', type: 'float32' },
  { address: 1120, name: 'Metros Tejidos T3', type: 'float32' },
  { address: 1130, name: 'Sacos Cortadora 1', type: 'int32' },
  { address: 1140, name: 'Sacos Cortadora 2', type: 'int32' },
  { address: 1150, name: 'Sacos Cortadora 3', type: 'int32' },
  { address: 1160, name: 'Sacos Cortadora 4', type: 'int32' },
];

export const PULSOS: Record<string, PulsosTarget> = {
  '1': { address: 1000, name: 'Pulsos Telar 1' },
  '2': { address: 1010, name: 'Pulsos Telar 2' },
  '3': { address: 1020, name: 'Pulsos Telar 3' },
  '4': { address: 1030, name: 'Pulsos Cortadora 1' },
  '5': { address: 1040, name: 'Pulsos Cortadora 2' },
  '6': { address: 1050, name: 'Pulsos Cortadora 3' },
  '7': { address: 1060, name: 'Pulsos Cortadora 4' },
};

export const PERIMETROS: Record<string, PerimetroTarget> = {
  '1': { address: 1070, name: 'Rodillo 1' },
  '2': { address: 1080, name: 'Rodillo 2' },
  '3': { address: 1090, name: 'Rodillo 3' },
};

export const M_MAP: Record<string, number> = {
  m0: 0,
  m1: 1,
  m2: 2,
  m3: 3,
  m4: 4,
  m5: 5,
  m6: 6,
};

export const PULSE_ADDRESSES = Object.values(PULSOS).map((x) => x.address);
