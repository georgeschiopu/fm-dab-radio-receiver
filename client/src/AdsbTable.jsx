// Table of every aircraft currently tracked. Rows are clickable to select and
// are highlighted when their blip is selected on the map (and vice versa).
// ICAO is the primary link to ADS-B Exchange, with the registration as a
// fallback; the callsign is plain text. A column shows the registration-country
// flag, and registration/type/operator are enriched from adsbdb. onGround / SPI
// (ident) come straight from the transponder.
import { useEffect, useMemo, useState } from 'react';
import { countryOf, flagEmoji } from './icaoCountry.js';
import { getAircraftInfo, getCachedAircraftInfo } from './adsbEnrich.js';

export default function AdsbTable({ aircraft = [], selected, onSelect }) {
  const [version, setVersion] = useState(0);
  const [sort, setSort] = useState(null); // null | { col: 'age' | 'icao', dir: 'desc' | 'asc' }

  // Clicking a column: first click sorts desc, second asc, third stops sorting.
  // Clicking a different column clears the previous column's sort.
  const toggleSort = (col) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'desc' };
      if (prev.dir === 'desc') return { col, dir: 'asc' };
      return null;
    });
  };

  // Kick off enrichment for any aircraft we haven't looked up yet.
  useEffect(() => {
    let cancelled = false;
    for (const a of aircraft) {
      if (!a.icao) continue;
      getAircraftInfo(a.icao).then(() => {
        if (!cancelled) setVersion((v) => v + 1);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [aircraft]);

  // With no sort applied, newly-detected aircraft float to the top (by addedAge).
  const sorted = useMemo(() => {
    const arr = [...aircraft];
    if (!sort) {
      arr.sort((x, y) => (x.addedAge ?? Number.POSITIVE_INFINITY) - (y.addedAge ?? Number.POSITIVE_INFINITY));
      return arr;
    }
    const asc = sort.dir === 'asc';
    if (sort.col === 'icao') {
      arr.sort((x, y) => {
        const a = String(x.icao || '').toLowerCase();
        const b = String(y.icao || '').toLowerCase();
        const c = a < b ? -1 : a > b ? 1 : 0;
        return asc ? c : -c;
      });
    } else {
      arr.sort((x, y) => {
        const a = x.age ?? Number.POSITIVE_INFINITY;
        const b = y.age ?? Number.POSITIVE_INFINITY;
        return asc ? a - b : b - a;
      });
    }
    return arr;
  }, [aircraft, sort]);

  if (!aircraft.length) {
    return <div className="stations-empty">No aircraft heard yet — tune to 1090 MHz.</div>;
  }

  return (
    <div className="adsb-table-wrap">
      <table className="adsb-table">
        <thead>
          <tr>
            <th
              className={`adsb-sort${sort?.col === 'icao' ? ' active' : ''}`}
              onClick={() => toggleSort('icao')}
              title="Sort by ICAO: 1st click desc, 2nd click asc, 3rd click stop"
            >
              ICAO{sort?.col === 'icao' ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
            </th>
            <th>Callsign</th>
            <th>Country</th>
            <th>Photo</th>
            <th>Type</th>
            <th>Registration</th>
            <th>Operator</th>
            <th>Airborne</th>
            <th>Alt (ft)</th>
            <th>Spd (kt)</th>
            <th>Trk</th>
            <th>Squawk</th>
            <th>Pos</th>
            <th
              className={`adsb-sort${sort?.col === 'age' ? ' active' : ''}`}
              onClick={() => toggleSort('age')}
              title="Sort by age: 1st click desc, 2nd click asc, 3rd click stop"
            >
              Age{sort?.col === 'age' ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => {
            const isSel = selected === a.icao;
            const { country, code } = countryOf(a.icao);
            const flag = flagEmoji(code);
            const info = getCachedAircraftInfo(a.icao);
            return (
              <tr
                key={a.icao}
                className={`adsb-row${isSel ? ' selected' : ''}${a.emergency ? ' emergency' : ''}`}
                onClick={() => onSelect && onSelect(a.icao)}
              >
                <td className="mono">
                  <a
                    className="adsb-link"
                    href={`https://globe.adsbexchange.com/?icao=${a.icao}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="View on ADS-B Exchange (by ICAO)"
                  >
                    {a.icao.toUpperCase()}
                  </a>
                </td>
                <td>{a.callsign || '—'}</td>
                <td className="adsb-flag" title={country || 'Unknown'}>
                  {flag}
                </td>
                <td title="Aircraft photo">
                  {info?.photo ? (
                    <img
                      className="adsb-photo"
                      src={info.photo}
                      alt={info.registration || info.type || 'aircraft'}
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : (
                    '—'
                  )}
                </td>
                <td>{info?.type || '—'}</td>
                <td className="mono">
                  {info?.registration ? (
                    <a
                      className="adsb-link"
                      href={`https://globe.adsbexchange.com/?reg=${encodeURIComponent(info.registration)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="View on ADS-B Exchange (by registration)"
                    >
                      {info.registration}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{info?.operator || '—'}</td>
                <td
                  className={`adsb-air${a.onGround === false ? ' air' : a.onGround === true ? ' ground' : ''}`}
                  title={a.spi ? 'Transponder IDENT active' : undefined}
                >
                  {a.onGround === true ? '✗' : a.onGround === false ? '✓' : '—'}
                  {a.spi ? ' · SPI' : ''}
                </td>
                <td>{a.altitude != null ? Math.round(a.altitude) : '—'}</td>
                <td>{a.speed != null ? Math.round(a.speed) : '—'}</td>
                <td>{a.track != null ? `${Math.round(a.track)}°` : '—'}</td>
                <td className="mono">{a.squawk || '—'}</td>
                <td>
                  {a.lat != null && a.lon != null
                    ? `${a.lat.toFixed(2)}, ${a.lon.toFixed(2)}`
                    : '—'}
                </td>
                <td>{a.age != null ? `${a.age}s` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
