# Teltonika FMC130 + EYE Sensor BTSMP1 EN12830 — One-Van Installer Setup Sheet

> **Status: Staging Software Validated / Physical Pilot Pending.**
> Do **not** sign off fleet rollout until the single pilot van passes every road-test gate in Section 6 using real Jamaican LTE coverage.

---

## 1. Hardware & Firmware Prerequisites

| Component | Requirement | Verification |
| --- | --- | --- |
| **Vehicle Tracker** | Teltonika **FMC130** Americas/LA LTE Cat-1 hardware variant supporting **B2 / B4 / B5 / B17 / B28** (do **not** install EMEA-only variant in Jamaica) | Confirm modem/band code on unit label before install |
| **FMC130 Firmware** | Base firmware **`03.29.00.Rev.18`** or newer (must support native **EYE Sensor Preset** + **Codec 8 Extended `0x8E`**) | SMS `getver` or Teltonika Configurator Status tab |
| **Configurator** | Teltonika Configurator **`v1.7.72+` (`B.3.29+`)** | Must match firmware revision |
| **Cargo Sensor** | Teltonika **EYE Sensor BTSMP1 EN12830** (`-40°C .. +85°C`, BLE + internal EN12830 flash) | Record printed **BLE MAC** and device code |
| **SIM Card** | Active Jamaican M2M data SIM (**Digicel Jamaica** or **Flow Jamaica**), SIM PIN disabled | Test SMS + PDP data attach in cab |

---

## 2. Jamaican SIM & APN Configuration

- Disable SIM PIN lock before inserting into FMC130.
- Configure **GPRS → APN Settings** in Teltonika Configurator:
  - **Digicel Jamaica:** confirm business M2M APN with account rep (commonly `web.digiceljamaica.com` or assigned private M2M APN; leave Username/Password blank unless carrier specifies).
  - **Flow Jamaica:** confirm business M2M APN with account rep (commonly `pp.internet` / assigned M2M APN).
- Verify outbound connectivity to gateway endpoint (TCP port **`5027`** for Codec 8 Extended gateway, or **`8883`** TLS if routing MQTT Codec JSON).

---

## 3. Gateway-to-HTTPS Configuration

The pilot backend receives telemetry over authenticated HTTPS (`POST /api/v1/telemetry/codec8e`, header `X-Telemetry-Key`), backed by the Teltonika binary Codec 8 Extended receiver (`backend/src/telemetry-gateway.ts`):

1. **System Tab:**
   - **Data Protocol:** **`Codec 8 Extended`** (`0x8E` — mandatory; standard Codec 8 drops BLE IDs `10800..10819`).
2. **GPRS → Server Settings:**
   - **Domain / Host:** Approved staging gateway FQDN/IP (deferred pending Azure gateway tier approval; use pilot bridge host during supervised bench test).
   - **Port:** **`5027`** | **Protocol:** **`TCP`** | **TLS:** Enable when provisioned on TLS listener.
3. **Records & Flash Buffering:**
   - **Send Period (Moving):** `60 s` (min distance `100 m`, angle `30°`)
   - **Send Period (Stop):** `300 s`
   - **Open Link Timeout / Response Timeout:** `30 s` / `30 s` (gateway sends the 4-byte record ACK **only** after backend PostgreSQL commit succeeds; FMC130 retains records in flash if cellular link drops).

---

## 4. Cargo Box Sensor Mounting & BLE Pairing (EYE BTSMP1)

1. **Mounting:** Mount EYE Sensor BTSMP1 inside the insulated cargo compartment near the upper return-air bulkhead (protected from high-pressure washdown jets and away from direct evaporator defrost coils). Record which compartment (`CHILLER-MAIN` `0–4°C` FRESH, or `FREEZER` `≤ -18°C` FROZEN).
2. **Teltonika Configurator → Bluetooth:**
   - **BT Radio:** `Enable (visible/scan)`
3. **Teltonika Configurator → Bluetooth 4.0 → Connection #1:**
   - **Working Mode:** **`EYE Sensor` Preset**
   - **MAC Address:** Enter printed **EYE BTSMP1 MAC** (mapped to **Slot 1** in platform enrollment)
   - **Extended AVL IO Elements Verified:** `10800` (Temp Slot 1, `int16 × 0.01 °C`), `10804` (Humidity), `10808` (Door/Magnet), `10812` (Movement), `10816` (Battery mV).
   - *(Optional dual-compartment truck: map second EYE BTSMP1 MAC to Connection #2 / Slot 2 -> `10801..10817`.)*
4. **Platform Enrollment (Administrator Only):**
   - Enroll `VehicleCompartment` -> `VehicleTracker` (IMEI) -> `TemperatureDevice` (Sensor code, MAC, slot `1`) and issue dedicated device/gateway key (`POST /api/v1/telemetry/credentials`).

---

## 5. Field SMS Diagnostic Quick Commands

Send to the FMC130 SIM MSISDN (with leading spaces if no SMS login/password set, e.g. `  getver`):

- `  getver` — confirms firmware (`03.29.00.Rev.18+`) and modem module ID.
- `  getinfo` — confirms GNSS satellite count, RTC time sync, GPRS attach, and flash records waiting.
- `  btgetlist 1` — confirms paired BLE EYE Sensor MAC is actively seen by the cab unit.
- `  getio` — confirms non-empty `10800` temperature IO value with cargo doors shut.

---

## 6. Road-Test & Coverage-Gap Checklist

- [ ] **Stationary Closed-Door BLE Test:** Close and latch loaded refrigerated box doors for 10 min; verify **Cold Chain → Temperature Devices** shows **`REPORTING`** (not **`SENSOR SIGNAL MISSING`**).
- [ ] **Moving Vehicle GPS + Cargo-Air Test:** Drive pilot route (>= 15 min); verify **Delivery Operations → Active Runs** displays moving coordinates, speed, capture timestamp, and live °C without stale warnings.
- [ ] **Custody & Lot Matching Check:** Assign two seafood lots at pickup, perform partial handover at Stop 1, verify readings link strictly to onboard lots at capture time, and verify manual `DRIVER_PICKUP` / `DELIVERY` handover checks stay separate.
- [ ] **Coverage-Gap Buffering Recovery:** Enter an LTE dead zone (or detach cellular antenna 5+ min), allow temperatures to shift (or test warm probe), reconnect LTE, and confirm buffered frames keep original `capturedAt`, trigger lot excursion alerts, do not overwrite newer live GPS/temperature values, and leave `0` duplicate alerts.
- [ ] **EYE App EN12830 CSV Recovery Drill:** Export internal logger CSV via Teltonika **EYE App**, upload through **History & EYE CSV**, and confirm `EYE_APP_RECOVERY_CSV` provenance.

**Physical Pilot Acceptance Gate:** Pending until all five checkboxes above pass on a live instrumented staging van.
