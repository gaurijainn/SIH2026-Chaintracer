import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface Check { status: string; detail?: string; latencyMs: number }
interface Report { status: string; mode: string; checks: Record<string, Check>; providers: Record<string, Check> }

/** B0 placeholder: proves the web container reaches the API. The real shell is F0. */
function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then(setReport)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1>PS 26183 · stack status</h1>
      {error && <p role="alert">API unreachable: {error}</p>}
      {report && (
        <>
          <p>Overall: <b>{report.status}</b> · data mode: <b>{report.mode}</b></p>
          <ul>
            {Object.entries({ ...report.checks, ...report.providers }).map(([k, v]) => (
              <li key={k}>{k}: {v.status}{v.detail ? ` (${v.detail})` : ''}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
