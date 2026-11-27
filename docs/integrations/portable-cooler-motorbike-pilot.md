# Portable Cooler Cold-Chain Pilot: Motorbike & Small Van Guide

## 1. Hardware Kit (Pilot Stage 1)

- **Insulated Container (Motorbike):** Reusable portable Igloo cooler (`PORTABLE_COOLER`, e.g. `IGLOO-MOTO-01`).
- **In-Cooler BLE Sensor:** Teltonika **EYE Sensor BTSMP1 EN12830** (`TELTONIKA_EYE_BTSMP1_EN12830`, paired in **Slot #1** on motorbike, or **Slots #1-#4** across multiple coolers on small van).
- **Motorbike Tracker (Candidate):** Teltonika **FMC234** (`TELTONIKA_FMC234`, IP67 rated external harness + LTE Cat-1 + GNSS + BLE 4.x). Supports **1 active portable cooler** at a time.
- **Small Van Tracker:** Teltonika **FMC130** (`TELTONIKA_FMC130`), supporting **multiple separately monitored coolers** (up to 4 paired EYE BTSMP1 sensors via Slots #1-#4, AVL Extended IDs `10800..10819`).

---

## 2. Physical Installation & Placement Rules

1. **Inside Cooler (EYE Sensor BTSMP1 EN12830):**
   - Mount horizontally on the upper interior lid/side-liner bracket using food-safe waterproof mounting adhesive/clip **at a representative air-space point near the load**.
   - Keep **clear of direct contact with fish fillets/carcasses, ice packs/gel packs, and bottom meltwater pooling** (avoid false freeze spikes or sealed moisture ingress).
   - Record the printed **BLE MAC address** and physical **Cooler ID** (e.g. `IGLOO-MOTO-01`) before closing the lid.
2. **External Tracker (FMC234 on Motorbike / FMC130 on Van):**
   - Mount FMC234 inside a weather-protected frame cavity or underseat compartment **outside** the insulated cooler wall, keeping line-of-sight / single insulated lid distance well within BLE range (< 3–5 m, no closed steel barrier blocking the BLE antenna).
   - Connect switched ignition/power cleanly to battery with inline fuse; verify external voltage reporting (`AVL IO 66`).

---

## 3. Platform Onboarding (`Delivery Zones & Fleet`)

1. Register fleet vehicle (`MOTORBIKE` with `TELTONIKA_FMC234` or `VAN` with `TELTONIKA_FMC130`) under the operating **Delivery Zone** (`Zone 1/2/3`).
2. Enroll tracker IMEI and SIM details (`Digicel Jamaica` or `Flow Jamaica`), and issue scoped telemetry key (`POST /api/v1/telemetry/credentials`).
3. Register reusable cooler ID (`IGLOO-MOTO-01`), pair its EYE BTSMP1 sensor (`deviceCode`, `bleMacAddress`, BLE `sensorSlot`), and assign to the bike or van (`POST /api/v1/telemetry/compartments/:id/assign`).
4. Verify **same-parish service rule** on the participating pilot vendor profile (`vendor.parish` matches customer `Order.deliveryParish`, mapped via active `DeliveryZoneParish`).

---

## 4. Field Checks Required Before Scaling Hardware Procurement

Physical hardware + carrier verification is mandatory before purchasing additional FMC234/BTSMP1 kits:

- [ ] **Exact Hardware Model & Modem Bands:** Confirm exact **FMC234** region variant (Americas/LATAM LTE bands **B2 / B4 / B5 / B17 / B28** used by Digicel Jamaica & Flow Jamaica) and **BTSMP1** firmware version (`EN12830` calibration certificate recorded).
- [ ] **APN & Socket/TLS Configuration:** Program Digicel (`pp.digicel.com`) or Flow M2M APN, protocol **Codec 8 Extended (`0x8E`)** -> TCP gateway `<telemetry-gateway-fqdn>:5027` (or TLS MQTT -> `/api/v1/telemetry/codec-json`).
- [ ] **Closed-Cooler BLE Penetration Under Ride Vibration:** Latch cooler closed, ride bike at pilot speed along delivery route for 20+ minutes, confirm **Cold Chain** stays `REPORTING` with zero `SENSOR_SIGNAL_MISSING` dropouts.
- [ ] **Cellular Dead-Zone Buffering & Duplicate Safety:** Cover/disable cellular mid-route for 5+ minutes, restore LTE, confirm delayed frames preserve original `capturedAt` with `LTE Buffered Recovery` without overwriting newer live GPS or duplicating alerts.
- [ ] **Custody Workflow & Manual Probe Check:** Confirm driver `My Deliveries` pickup load (`order + lot + quantity + cooler ID`), partial/full handover closing, cooler-air vs manual core product check distinction, and customer live tracking visibility strictly while `stage === PICKED_UP`.
