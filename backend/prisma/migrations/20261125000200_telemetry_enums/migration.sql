-- Migration #73: Create PostgreSQL enums for live vehicle GPS & cold-chain
-- telemetry separately before any columns or tables reference them (avoids PG 55P04).

CREATE TYPE "TelemetryProtocol" AS ENUM (
  'TELTONIKA_CODEC_8E',
  'TELTONIKA_CODEC_JSON',
  'HTTP_JSON',
  'EYE_APP_CSV'
);

CREATE TYPE "TrackerHardwareModel" AS ENUM (
  'TELTONIKA_FMC130',
  'GENERIC_GNSS_LTE'
);

CREATE TYPE "TemperatureSensorModel" AS ENUM (
  'TELTONIKA_EYE_BTSMP1_EN12830',
  'GENERIC_BLE_PROBE'
);

CREATE TYPE "TemperatureReadingOrigin" AS ENUM (
  'MANUAL_PRODUCT_CHECK',
  'CARGO_AIR_SENSOR',
  'EYE_APP_RECOVERY_CSV'
);

CREATE TYPE "TelemetryGapKind" AS ENUM (
  'LTE_BUFFERED_RECOVERY',
  'SENSOR_SIGNAL_MISSING',
  'GNSS_NO_FIX'
);

CREATE TYPE "TelemetryCredentialScope" AS ENUM (
  'DEVICE_TRACKER',
  'GATEWAY'
);
