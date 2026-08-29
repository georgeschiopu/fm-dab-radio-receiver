import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Circle, Tooltip, useMap } from 'react-leaflet';
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
              <CircleMarker
                key={a.icao}
                center={[a.lat, a.lon]}
                radius={isSel ? 8 : 6}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.9, weight: 2 }}
                eventHandlers={{ click: () => onSelect && onSelect(a.icao) }}
              >
                <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                  <span className="adsb-tip">
                    {a.callsign || a.icao.toUpperCase()}
                    {a.altitude != null ? ` · ${Math.round(a.altitude)} ft` : ''}
                  </span>
                </Tooltip>
              </CircleMarker>
            );
          })}
          <CircleMarker
            center={[home.lat, home.lon]}
            radius={4}
            pathOptions={{ color: '#ffffff', fillColor: '#333333', fillOpacity: 1, weight: 2 }}
          >
            <Tooltip direction="top" offset={[0, -8]}>HOME</Tooltip>
          </CircleMarker>
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
