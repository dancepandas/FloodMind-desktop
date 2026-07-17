import { useEffect, useState } from "react";
import OfficeFallback from "./OfficeFallback";

// Cap rendered rows per sheet so a giant workbook can't hang the panel.
const MAX_ROWS = 1000;

interface Sheet {
  name: string;
  rows: string[][];
}

/** Parse a .xlsx with SheetJS and render each sheet as a table, with tabs to
 *  switch sheets. The library is imported dynamically. */
export default function XlsxPreview({ data, path }: { data: ArrayBuffer; path: string }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(data, { type: "array" });
        const out: Sheet[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
            header: 1,
            raw: false,
            defval: "",
          });
          const rows = (raw as unknown[][])
            .slice(0, MAX_ROWS)
            .map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))) : [String(r)]));
          return { name, rows };
        });
        if (cancelled) return;
        setSheets(out);
        setActive(0);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (failed) return <OfficeFallback path={path} />;
  if (!sheets.length) return <div className="preview-loading">加载中…</div>;

  const sheet = sheets[active] ?? sheets[0];
  const truncated = sheet.rows.length >= MAX_ROWS;

  return (
    <div className="office-preview xlsx-preview">
      {sheets.length > 1 && (
        <div className="xlsx-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              className={"xlsx-tab" + (i === active ? " active" : "")}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="xlsx-table-wrap">
        <table className="xlsx-table">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="xlsx-rownum">{ri + 1}</td>
                {row.map((c, ci) => (
                  <td key={ci}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && <div className="xlsx-truncated">…（仅预览前 {MAX_ROWS} 行）</div>}
      </div>
    </div>
  );
}
