import time
from pymodbus.client import ModbusTcpClient

IP_PLC = "192.168.100.64"

# Diccionario de memorias M
M_MAP = {f"m{i}": i for i in range(7)} # Genera m0 a m6 automáticamente

def reset_m():
    client = ModbusTcpClient(IP_PLC, port=502)
    print("--- PROGRAMA DE RESETEO DE MEMORIAS (M0-M6) ---")
    
    try:
        while True:
            cmd = input("\nIngrese M a resetear (m0-m6) o 'salir': ").lower().strip()
            if cmd == 'salir': break
            
            if cmd in M_MAP:
                if client.connect():
                    print(f"[*] Activando {cmd}...")
                    client.write_coil(M_MAP[cmd], True)  # Enciende
                    time.sleep(1)                      # Espera 1 seg
                    client.write_coil(M_MAP[cmd], False) # Apaga
                    print(f"[OK] {cmd} reseteado.")
                else:
                    print("❌ Error: PLC no alcanzable.")
            else:
                print("⚠️ Comando no válido.")
    finally:
        client.close()

if __name__ == "__main__":
    reset_m()