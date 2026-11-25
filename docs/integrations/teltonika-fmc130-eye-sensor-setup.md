# Teltonika FMC130 + EYE Sensor BTSMP1 EN12830 Setup & Pilot Guide

## 1. Architecture Summary

- **Tracker:** Teltonika **FMC130** (LTE Cat-1 + GNSS + Bluetooth LE 4.x)
- **Cargo Sensor:** Teltonika **EYE Sensor BTSMP1 EN12830** (`-40°C` to `+85°C`, internal ~33,000-record flash)
- **Wire Protocol:** **Codec 8 Extended (`0x8E`)** (mandatory — standard Codec 8 drops 2-byte EYE Sensor IO IDs `10800..10819`) or **Codec JSON** (over TLS MQTT via Azure IoT Hub → `POST /api/v1/telemetry/codec-json`).
- **TCP/TLS Gateway (`backend/src/telemetry-gateway.ts`):**
  1. Validates 15-digit IMEI against `POST /api/v1/telemetry/authorize-imei`.
  2. Forwards raw binary frames to `POST /api/v1/telemetry/codec8e` with `X-Telemetry-Key`.
  3. Writes the 4-byte record count ACK back to the FMC130 **only after** PostgreSQL commit succeeds. If cellular coverage or the backend drops, the FMC130 keeps unacknowledged records in flash.
- **Note on Azure Container Apps (`cae-irie-staging`):** `cae-irie-staging` has `vnet: null` and does not support external raw TCP ingress. Run `npm run start:telemetry-gateway` over a supervised pilot bridge forwarding Codec 8E to HTTPS `/api/v1/telemetry/codec8e`, or after Tier-3 IaC & cost approval provision an ACI TCP listener (`5027`) or Azure IoT Hub (`8883` TLS MQTT `Codec JSON`).

---

## 2. Jamaican SIM & Regional Modem Verification (Required Before Bulk Hardware Purchase)

1. Verify the **exact FMC130 hardware variant** supports Jamaican carrier LTE bands:
   - **Digicel Jamaica & Flow Jamaica** primarily operate LTE **Band 2 (1900 MHz)**, **Band 4 (1700/2100 AWS)**, **Band 5 (850 MHz)**, **Band 17 (700 MHz)**, and **Band 28 (700 MHz APT)** alongside GSM/UMTS fallback depending on parish coverage.
   - Do **not** purchase EMEA-only `FMC130-QIB0` hardware for Jamaica — select the Americas/Latin-America LTE Cat-1 variant carrying **B2/B4/B5/B17/B28** and verify registration on a real rural/coastal cold-chain route between landing sites and Kingston before fleet-wide procurement.
2. Provision an **M2M telemetry SIM** with APN configured (`pp.digicel.com` or Flow business M2M APN; verify static/outbound TCP permissions on port `5027` or MQTT `8883` + HTTP/HTTPS).
3. Record SIM `ICCID` and `simCarrier` against the `VehicleTracker` row in Irie Fishmongers.

---

## 3. Teltonika Configurator Settings (FMC130 + EYE BTSMP1)

| Group | Parameter | Recommended Pilot Value |
| --- | --- | --- |
| **System** | Data Protocol | **Codec 8 Extended (`0x8E`)** |
| **GPRS → Server Settings** | Domain / Port / Protocol | `<telemetry-gateway-fqdn>` / `5027` / TCP (or IoT Hub `8883` TLS MQTT `Codec JSON`) |
| **Data Acquisition** | On Stop / Moving | Every `60 s` moving, `300 s` stopped (minimum distance `100 m`) |
| **Records / Flash** | Sort Mode | **Newest First** or **Oldest First** (Oldest First preserves outage order) |
| **Bluetooth → General** | BT Power / BLE Scan | **Enabled**, Continuous scan every `30 s` |
| **Bluetooth 4.0 → Connection #1** | Mode / Preset | **EYE Sensor (Preset)** matching sensor **BLE MAC** in **Slot 1** |
| **I/O (Slot 1 EYE)** | Temperature / Humidity / Magnet / Movement / Battery | Extended AVL IDs: `10800` (signed int16 × `0.01` °C), `10804`, `10808`, `10812`, `10816` |
| **I/O (Slots 2..4 optional)** | Dual-zone Freezer (`FROZEN`) | Map Freezer BTSMP1 MAC to **Slot 2** (`10801`, `10805`, `10809`, `10813`, `10817`) |

---

## 4. Physical Compartment Installation & Pilot Validation Checklist

1. **Closed Metal/Insulated Box Bluetooth Test:**
   - Mount EYE Sensor BTSMP1 inside the refrigerated cargo box (shielded from direct washdown jets, away from evaporator defrost blast, near load air-return zone).
   - **Close and latch the cargo door fully**, drive an actual test loop, and confirm **Cold Chain → Temperature Devices** stays `REPORTING` rather than `SENSOR_SIGNAL_MISSING` (GPS arriving without AVL `10800` data).
2. **Staging Pilot Gate Criteria Before Scaling:**
   - [ ] Enroll staging vehicle (`VehicleCompartment` + `VehicleTracker` + `TemperatureDevice`), issue scoped token via `POST /api/v1/telemetry/credentials`.
   - [ ] **In-range test:** Confirm live GPS renders on **Delivery Operations → Active Runs**, live °C updates on **Cold Chain → Temperature Devices**, and no alert fires.
   - [ ] **Excursion test:** Trigger warming above `4.0°C` (fresh) or `-18.0°C` (frozen); confirm `TemperatureAlert`, `EmergencyResponse` (`CRITICAL`/`EMERGENCY`), and lot hold (`UNDER_REVIEW`/`QUARANTINED`) trigger identically to manual checks.
   - [ ] **LTE Drop & Buffered Recovery:** Disconnect antenna / enter dead zone for 5+ min, restore LTE; verify buffered records keep original `capturedAt`, flag `LTE_BUFFERED_RECOVERY` (`isDelayed = true`), raise missed excursion alerts without clobbering newer live GPS coordinates, and duplicate retry sends create `0` duplicate alerts.
   - [ ] **EYE App EN12830 CSV Recovery:** Download internal sensor log via **Teltonika EYE App**, upload CSV via `POST /api/v1/telemetry/sensors/:sensorId/csv-recovery` (or Admin UI modal); verify separate `EYE_APP_RECOVERY_CSV` audit provenance.
   - [ ] **Custody & Manual Check Separation:** Confirm automated `CARGO_AIR_SENSOR` telemetry never marks manual `DRIVER_PICKUP` / `DELIVERY` product temperature checks as complete, and handover cleanly closes attribution intervals.
