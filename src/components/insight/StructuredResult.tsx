import { detectStructured } from '../../lib/structuredOutput';
import { BarChart, LineChart } from './charts';
import { MiniMarkdown } from './MiniMarkdown';

export function StructuredResult({ text }: { text: string }) {
  const blocks = detectStructured(text);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'table':
            return (
              <div key={i} className="overflow-x-auto">
                <table className="text-[11px] border-collapse">
                  <thead>
                    <tr>
                      {b.headers.map((h, c) => (
                        <th
                          key={c}
                          className="text-left font-medium text-text-primary px-2 py-1 border-b border-seam-strong"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((v, c) => (
                          <td key={c} className="px-2 py-0.5 text-text-secondary border-b border-seam">
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'bars':
            return <BarChart key={i} items={b.items} />;
          case 'line':
            return <LineChart key={i} points={b.points} />;
          default:
            return <MiniMarkdown key={i} text={b.text} />;
        }
      })}
    </div>
  );
}
