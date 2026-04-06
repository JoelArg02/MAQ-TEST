import time
from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadBuilder

# =================================================================
# CONFIGURACIÓN DE CONEXIÓN
# =================================================================
IP_PLC = "192.168.100.64"
PUERTO = 502

# =================================================================
# MAPEO DE REGISTROS DE PULSOS (ENTEROS 32 BITS)
# =================================================================
PULSOS = {
    "1": {"address": 1000, "name": "Pulsos Telar 1"},
    "2": {"address": 1010, "name": "Pulsos Telar 2"},
    "3": {"address": 1020, "name": "Pulsos Telar 3"},
    "4": {"address": 1030, "name": "Pulsos Cortadora 1"},
    "5": {"address": 1040, "name": "Pulsos Cortadora 2"},
    "6": {"address": 1050, "name": "Pulsos Cortadora 3"},
    "7": {"address": 1060, "name": "Pulsos Cortadora 4"}
}

def escribir_pulsos():
    """Programa para ingresar manualmente los pulsos (Enteros de 32 bits)."""
    client = ModbusTcpClient(IP_PLC, port=PUERTO, timeout=3)
    
    print("====================================================")
    print("   INGRESO MANUAL DE PULSOS (VERSIÓN CORREGIDA)     ")
    print("====================================================")

    try:
        while True:
            # Mostrar lista de máquinas
            print("\nID | MÁQUINA")
            print("---+-----------")
            for key, info in PULSOS.items():
                print(f" {key} | {info['name']} (D{info['address']})")
            
            seleccion = input("\nSeleccione ID de máquina o 'salir': ").strip().lower()
            
            if seleccion == 'salir':
                break
            
            if seleccion in PULSOS:
                while True:
                    entrada = input(f"Ingrese nuevos pulsos para {PULSOS[seleccion]['name']}: ").strip()
                    try:
                        # Convertimos a entero (no se permiten decimales en pulsos)
                        valor_int = int(entrada)
                        
                        if valor_int < 0:
                            print("⚠️ ERROR: Los pulsos no pueden ser negativos.")
                            continue
                        break 
                    except ValueError:
                        print(f"⚠️ ERROR: '{entrada}' no es un número entero válido.")

                if client.connect():
                    try:
                        # 1. Construimos el payload para un ENTERO de 32 bits (UINT)
                        # Usamos BIG endian para bytes y LITTLE para palabras (Word Swap)
                        builder = BinaryPayloadBuilder(byteorder=Endian.BIG, wordorder=Endian.LITTLE)
                        builder.add_32bit_uint(valor_int)
                        
                        # 2. CONVERSIÓN CRUCIAL: builder.to_registers() devuelve la lista [int, int]
                        # Esto evita el error de "'list' object has no attribute 'registers'"
                        payload = builder.to_registers()
                        
                        address = PULSOS[seleccion]['address']
                        
                        # 3. Escribimos en el PLC enviando la lista directamente
                        # Eliminamos 'skip_encode' que causa TypeError
                        client.write_registers(address, payload, slave=1)
                        
                        print(f"[✅] ACTUALIZADO: {PULSOS[seleccion]['name']} = {valor_int} pulsos")
                    except Exception as e:
                        print(f"❌ Error al escribir: {e}")
                else:
                    print(f"❌ ERROR DE RED: No se pudo conectar con {IP_PLC}")
            else:
                print("⚠️ ID no válido.")

    finally:
        client.close()
        print("Conexión finalizada.")

if __name__ == "__main__":
    escribir_pulsos()
