import crypto from 'node:crypto';

export const MESHTASTIC_SAMPLE_RATE = 1_000_000;
export const MESHTASTIC_DEFAULT_FREQ = 869_525_000;
export const MESHTASTIC_IF_OFFSET = 25_000;

const DEFAULT_KEY = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01,
]);

const PORT_NAMES = {
  1: 'TEXT_MESSAGE_APP',
  2: 'REMOTE_HARDWARE_APP',
  3: 'POSITION_APP',
  4: 'NODEINFO_APP',
  5: 'ROUTING_APP',
  67: 'TELEMETRY_APP',
};

const text = (entry) => (entry && entry.wire === 2 ? entry.value.toString('utf8') : undefined);
const integer = (entry) => (entry && entry.wire === 0 ? Number(entry.value) : undefined);

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift <= 63n) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, offset: pos };
    shift += 7n;
  }
  throw new Error('invalid protobuf varint');
}

function fields(buf) {
  const out = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    let value;
    if (wire === 0) {
      const item = readVarint(buf, offset);
      value = item.value;
      offset = item.offset;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error('invalid protobuf fixed64');
      value = buf.subarray(offset, offset + 8);
      offset += 8;
    } else if (wire === 2) {
      const item = readVarint(buf, offset);
      offset = item.offset;
      const length = Number(item.value);
      if (length < 0 || offset + length > buf.length) throw new Error('invalid protobuf bytes');
      value = buf.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error('invalid protobuf fixed32');
      value = buf.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    const list = out.get(number) || [];
    list.push({ wire, value });
    out.set(number, list);
  }
  return out;
}

const first = (map, number) => (map.get(number) || [])[0];

function signed32(value) {
  const n = Number(BigInt.asIntN(32, value));
  return Number.isFinite(n) ? n : undefined;
}

function float32(entry) {
  return entry && entry.wire === 5 ? entry.value.readFloatLE(0) : undefined;
}

function resolveKey(raw = 'default') {
  const value = String(raw || 'default').trim();
  if (!value || value.toLowerCase() === 'default' || value.toLowerCase() === 'aq==') return Buffer.from(DEFAULT_KEY);
  const candidate = value.toLowerCase().startsWith('0x') ? value.slice(2) : value;
  let key;
  if (/^[0-9a-f]+$/i.test(candidate) && candidate.length % 2 === 0) {
    key = Buffer.from(candidate, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }
  if (key.length === 1) {
    const expanded = Buffer.from(DEFAULT_KEY);
    expanded[15] = (expanded[15] + key[0] - 1) & 0xff;
    return expanded;
  }
  if (key.length === 16 || key.length === 32) return key;
  if (key.length > 1 && key.length < 16) return Buffer.concat([key, Buffer.alloc(16 - key.length)]);
  if (key.length > 16 && key.length < 32) return Buffer.concat([key, Buffer.alloc(32 - key.length)]);
  throw new Error('Meshtastic PSK must be default, hex, or Base64 with 1-32 decoded bytes');
}

function nodeId(value) {
  return `!${value.toString(16).padStart(8, '0')}`;
}

function parsePosition(payload) {
  const map = fields(payload);
  const lat = first(map, 1)?.value;
  const lon = first(map, 2)?.value;
  const altitude = integer(first(map, 3));
  const result = {};
  if (lat !== undefined) result.latitude = signed32(lat) / 10_000_000;
  if (lon !== undefined) result.longitude = signed32(lon) / 10_000_000;
  if (altitude !== undefined) result.altitude = altitude;
  return Object.keys(result).length ? result : null;
}

function parseUser(payload) {
  const map = fields(payload);
  const result = {};
  const id = text(first(map, 1));
  const longName = text(first(map, 2));
  const shortName = text(first(map, 3));
  const hwModel = integer(first(map, 4));
  const role = integer(first(map, 5));
  if (id) result.id = id;
  if (longName) result.longName = longName;
  if (shortName) result.shortName = shortName;
  if (hwModel !== undefined) result.hwModel = hwModel;
  if (role !== undefined) result.role = role;
  return Object.keys(result).length ? result : null;
}

function parseTelemetry(payload) {
  const map = fields(payload);
  const result = {};
  const device = first(map, 2);
  const environment = first(map, 3);
  if (device?.wire === 2) {
    const data = fields(device.value);
    const battery = integer(first(data, 1));
    const voltage = float32(first(data, 2));
    const channelUse = float32(first(data, 3));
    const airUse = float32(first(data, 4));
    const uptime = integer(first(data, 5));
    if (battery !== undefined) result.batteryLevel = battery;
    if (voltage !== undefined) result.voltage = voltage;
    if (channelUse !== undefined) result.channelUtilization = channelUse;
    if (airUse !== undefined) result.airUtilization = airUse;
    if (uptime !== undefined) result.uptimeSeconds = uptime;
  }
  if (environment?.wire === 2) {
    const data = fields(environment.value);
    const temperature = float32(first(data, 1));
    const humidity = float32(first(data, 2));
    const pressure = float32(first(data, 3));
    if (temperature !== undefined) result.temperature = temperature;
    if (humidity !== undefined) result.relativeHumidity = humidity;
    if (pressure !== undefined) result.barometricPressure = pressure;
  }
  return Object.keys(result).length ? result : null;
}

function decodePayload(data, key) {
  if (data.length <= 16) return {};
  const packetId = data.readUInt32LE(8);
  const src = data.readUInt32LE(4);
  const iv = Buffer.alloc(16);
  data.subarray(8, 12).copy(iv, 0);
  data.subarray(4, 8).copy(iv, 8);
  const decipher = crypto.createDecipheriv(key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr', key, iv);
  const decoded = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  const map = fields(decoded);
  const port = integer(first(map, 1));
  const payload = first(map, 2)?.value;
  if (port === undefined || !payload) return {};
  const result = { port, portName: PORT_NAMES[port] || `PORT_${port}` };
  if (port === 1 || port === 7) result.message = payload.toString('utf8');
  else if (port === 3) result.position = parsePosition(payload);
  else if (port === 4) result.node = parseUser(payload);
  else if (port === 67) result.telemetry = parseTelemetry(payload);
  return result;
}

export function parseMeshtasticPacket(packet, key = 'default', seen = new Map(), nodes = new Map()) {
  if (!packet || Number(packet.crc) < 1 || typeof packet.payload !== 'string') return null;
  const data = Buffer.from(packet.payload, 'base64');
  if (data.length < 16) return null;
  const dst = data.readUInt32LE(0);
  const src = data.readUInt32LE(4);
  const packetId = data.readUInt32LE(8);
  const dedupeKey = `${src}:${packetId}`;
  const now = Date.now();
  if (seen.has(dedupeKey) && now - seen.get(dedupeKey) < 60_000) return null;
  seen.set(dedupeKey, now);
  if (seen.size > 4096) {
    for (const [id, timestamp] of seen) if (now - timestamp >= 60_000) seen.delete(id);
  }
  const flags = data[12];
  const hopLimit = flags & 0x07;
  const hopStart = (flags >> 5) & 0x07;
  let decoded = {};
  try {
    decoded = decodePayload(data, resolveKey(key));
  } catch {
    // Headers remain useful when the channel key is unavailable or incorrect.
  }
  const node = nodes.get(src) || {};
  if (decoded.node) Object.assign(node, decoded.node);
  if (decoded.position) Object.assign(node, decoded.position);
  if (decoded.telemetry) Object.assign(node, decoded.telemetry);
  if (Object.keys(node).length) nodes.set(src, node);
  return {
    timestamp: now,
    src: nodeId(src),
    dst: nodeId(dst),
    packetId,
    channelHash: data[13],
    hops: `${hopStart - hopLimit}/${hopStart}`,
    rssi: Number.isFinite(Number(packet.rssi)) ? Number(packet.rssi) : null,
    snr: Number.isFinite(Number(packet.snr)) ? Number(packet.snr) : null,
    spreadFactor: Number.isFinite(Number(packet.sf)) ? Number(packet.sf) : null,
    bandwidth: Number.isFinite(Number(packet.bw)) ? Number(packet.bw) : null,
    ...decoded,
    node: Object.keys(node).length ? node : undefined,
  };
}

export function resolveMeshtasticKey(raw) {
  return resolveKey(raw);
}
