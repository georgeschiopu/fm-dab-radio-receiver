// Table of every aircraft currently tracked. Rows are clickable to select and
// are highlighted when their blip is selected on the map (and vice versa).
export default function AdsbTable({ aircraft = [], selected, onSelect }) {
  if (!aircraft.length) {
    return <div className="stations-empty">No aircraft heard yet — tune to 1090 MHz.</div>;
  }
  return (
    <div className="adsb-table-wrap">
      <table className="adsb-table">
        <thead>
          <tr>
            <th>ICAO</th>
            <th>Callsign</th>
            <th>Alt (ft)</th>
            <th>Spd (kt)</th>
            <th>Trk</th>
            <th>Squawk</th>
            <th>Pos</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {aircraft.map((a) => {
            const isSel = selected === a.icao;
            return (
              <tr
                key={a.icao}
                className={`adsb-row${isSel ? ' selected' : ''}${a.emergency ? ' emergency' : ''}`}
                onClick={() => onSelect && onSelect(a.icao)}
              >
                <td className="mono">{a.icao.toUpperCase()}</td>
                <td>{a.callsign || '—'}</td>
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
