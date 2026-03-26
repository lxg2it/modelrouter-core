/**
 * Shared CSS design system for all HTML pages.
 * Single-accent (orange), typography-driven, documentation-style.
 */

export const SHARED_HEAD = /* html */ `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
`;

export const SHARED_CSS = /* css */ `
  :root {
    --bg: #111;
    --surface: #1a1a1a;
    --surface2: #222;
    --text: #e8e6e3;
    --muted: #888;
    --accent: #ff6b35;
    --green: #4a9;
    --red: #f44;
    --warn: #d97706;
    --border: #2a2a2a;
    --code-bg: #0c0c0c;
    --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f9f8f6;
      --surface: #fff;
      --surface2: #f2f1ef;
      --text: #1a1a1a;
      --muted: #666;
      --accent: #e85d20;
      --green: #2a7a4a;
      --red: #c0392b;
      --warn: #b45309;
      --border: #e0ddd8;
      --code-bg: #f2f1ef;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.7;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre { font-family: var(--mono); }
  .page { max-width: 620px; margin: 0 auto; padding: 60px 24px 80px; }
  .page-wide { max-width: 860px; margin: 0 auto; padding: 60px 24px 80px; }

  /* ── Header ── */
  .header { margin-bottom: 48px; }
  .header-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
  .title { font-family: var(--mono); font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
  .title a { color: var(--text); }
  .title a:hover { color: var(--accent); text-decoration: none; }
  .nav-link { font-size: 13px; color: var(--accent); font-family: var(--mono); }
  .nav-link:hover { opacity: 0.8; text-decoration: none; }
  .subtitle { font-size: 15px; color: var(--muted); margin-bottom: 16px; max-width: 480px; }

  /* ── Section headings ── */
  .section-head {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--muted);
    margin: 40px 0 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  /* ── Content ── */
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; font-family: var(--mono); }
  h2 { font-size: 14px; font-weight: 700; color: var(--text); margin: 28px 0 8px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 1px; }
  p { color: var(--text); margin-bottom: 12px; }
  p strong { color: var(--text); }
  ul { color: var(--text); padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 4px; }
  li strong { color: var(--text); }

  /* ── Callout / highlight blocks ── */
  .callout {
    background: var(--surface);
    border-left: 3px solid var(--accent);
    padding: 14px 18px;
    margin: 20px 0;
    font-size: 14px;
  }
  .callout p { margin-bottom: 0; }

  /* ── Code ── */
  code {
    font-size: 13px;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 2px;
    color: var(--text);
  }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; }
  table td, table th {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    vertical-align: top;
  }
  table th { text-align: left; color: var(--muted); font-weight: 400; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  table tr:last-child td { border-bottom: none; }

  /* ── Cards ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 20px;
    margin-bottom: 16px;
  }
  .card-title {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 12px;
  }

  /* ── Buttons ── */
  .btn {
    display: inline-block;
    padding: 8px 16px;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    border: none;
    cursor: pointer;
    text-decoration: none;
  }
  .btn-primary { background: var(--accent); color: #111; }
  .btn-primary:hover { opacity: 0.85; text-decoration: none; }
  .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { border-color: var(--muted); text-decoration: none; }
  .btn-danger { background: #422; color: #f44; border: 1px solid #622; }
  .btn-danger:hover { background: #533; text-decoration: none; }

  /* ── Forms ── */
  input[type="text"], input[type="email"], input[type="number"], input[type="password"], select {
    background: var(--code-bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: var(--mono);
    font-size: 13px;
    padding: 8px 12px;
    width: 100%;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }

  /* ── Footer ── */
  .footer {
    margin-top: 48px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .footer-links { display: flex; gap: 16px; flex-wrap: wrap; }
  .footer-links a { font-size: 12px; color: var(--muted); font-family: var(--mono); }
  .footer-links a:hover { color: var(--accent); text-decoration: none; }

  /* ── Mobile ── */
  @media (max-width: 600px) {
    .page, .page-wide { padding: 40px 16px 60px; }
  }
`;

export function pageFooter(currentPage?: string): string {
  const links = [
    { href: '/', label: 'home' },
    { href: '/profile', label: 'profile' },
    { href: '/try', label: 'try' },
    { href: '/health', label: 'health' },
    { href: '/v1/models', label: 'models' },
    { href: '/docs', label: 'docs' },
    { href: '/changelog', label: 'changelog' },
    { href: '/status', label: 'status' },
    { href: '/privacy', label: 'privacy' },
    { href: '/terms', label: 'terms' },
  ];
  const linkHtml = links
    .filter(l => l.label !== currentPage)
    .map(l => `<a href="${l.href}">${l.label}</a>`)
    .join('\n      ');
  return /* html */ `
  <div class="footer">
    <div class="footer-links">
      ${linkHtml}
    </div>
  </div>`;
}
