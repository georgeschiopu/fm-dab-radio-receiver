import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Web-Mercator metres per pixel at a given latitude and zoom.
function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// Pick a zoom so that the coverage circle (rangeKm) roughly fills the viewport.
function zoomForRange(lat, rangeKm) {
  const range = Math.min(Math.max(rangeKm || 100, 1), 250);
  const targetMpp = 5 * range; // ~200px radius for range m
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / targetMpp);
  return Math.max(4, Math.min(15, Math.round(z)));
}

function colorFor(a) {
  return a.emergency ? '#ff5252' : a.altitude > 30000 ? '#ffd166' : '#4fd1ff';
}

// Small plane icon (pointing north), rotated to the aircraft's ground track.
// Built with a divIcon so no Leaflet marker image assets are needed and the
// icon can be recoloured per aircraft.
function planeIcon(color, track, selected) {
  const stroke = selected ? '#ffffff' : '#0a0e14';
  const heading = Number.isFinite(track) ? track : 0;
  const ring = selected
    ? '<circle cx="12" cy="12" r="10" fill="none" stroke="#ffffff" stroke-width="2"/>'
    : '';
  return L.divIcon({
    className: 'adsb-plane-slot',
    html: `<svg viewBox="0 0 24 24" width="24" height="24" style="transform: rotate(${heading}deg); transform-origin: 12px 12px; overflow: visible;">
      ${ring}
      <path fill="${color}" stroke="${stroke}" stroke-width="1.1" d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
    </svg>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// Small home-point marker centred on the configured lat/lon.
const homeIcon = L.divIcon({
  className: 'adsb-plane-slot',
  html: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="6" fill="#f0883e" stroke="#ffffff" stroke-width="2"/></svg>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// Keeps the view centred on the home point. Only triggers when the home point
// or the selected range changes, so continuous aircraft updates don't reset
// an operator's pan/zoom.
function Recenter({ lat, lon, zoom }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lon], zoom);
  }, [lat, lon, zoom, map]);
  return null;
}

// Offline-friendly map: OpenStreetMap tiles centred on the configured home
// point (HOME_LAT / HOME_LON from docker-compose). Aircraft with a known
// position are plotted as markers; clicking one syncs with the table.
export default function AdsbMap({ aircraft = [], homeLat, homeLon, rangeKm = 100, selected, onSelect }) {
  const home = useMemo(() => {
    if (typeof homeLat === 'number' && typeof homeLon === 'number') return { lat: homeLat, lon: homeLon };
    const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);
    if (positioned.length) {
      return {
        lat: positioned.reduce((s, a) => s + a.lat, 0) / positioned.length,
        lon: positioned.reduce((s, a) => s + a.lon, 0) / positioned.length,
      };
    }
    return { lat: 0, lon: 0 };
  }, [homeLat, homeLon, aircraft]);

  const zoom = useMemo(() => zoomForRange(home.lat, rangeKm), [home.lat, rangeKm]);
  const homeValid = typeof homeLat === 'number' && typeof homeLon === 'number';
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);

  return (
    <div className="adsb-map">
      <div className="adsb-map-frame">
        <MapContainer center={[home.lat, home.lon]} zoom={zoom} className="adsb-map-leaflet">
          <Recenter lat={home.lat} lon={home.lon} zoom={zoom} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Circle
            center={[home.lat, home.lon]}
            radius={rangeKm * 1000}
            pathOptions={{ color: '#4fd1ff', fillColor: '#4fd1ff', fillOpacity: 0.06, weight: 1, dashArray: '4 4' }}
          />
          {positioned.map((a) => {
            const isSel = selected === a.icao;
            const color = colorFor(a);
            return (
              <Marker
                key={a.icao}
                position={[a.lat, a.lon]}
                icon={planeIcon(color, a.track, isSel)}
                eventHandlers={{ click: () => onSelect && onSelect(a.icao) }}
              >
                <Tooltip direction="top" offset={[0, -14]} opacity={1}>
                  <span className="adsb-tip">
                    {a.callsign || a.icao.toUpperCase()}
                    {a.altitude != null ? ` · ${Math.round(a.altitude)} ft` : ''}
                  </span>
                </Tooltip>
              </Marker>
            );
          })}
          <Marker position={[home.lat, home.lon]} icon={homeIcon}>
            <Tooltip direction="top" offset={[0, -10]}>HOME</Tooltip>
          </Marker>
        </MapContainer>
      </div>
      {!homeValid && (
        <div className="adsb-map-hint">
          Set HOME_LAT / HOME_LON for a fixed centre (currently tracking the heard fleet centroid).
        </div>
      )}
      <div className="adsb-map-meta">
        Centre {home.lat.toFixed(3)}, {home.lon.toFixed(3)} · range {rangeKm} km · {positioned.length}/{aircraft.length} positioned
      </div>
    </div>
  );
}
