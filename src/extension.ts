import * as vscode from 'vscode';

const OZ_TO_GRAM = 31.1034768;

type SgeQuote = {
  heyue: string;
  times: string[];
  data: (string | number)[];
  delaystr: string; // e.g. "2025年04月14日 22:28:55"
};

type GoldSnapshot = {
  sgeSymbol: string;
  sgePriceCnyPerGram?: number;
  sgeUpdateText?: string;
  xauUsdPerOz?: number;
  usdCny?: number;
  xauCnyPerGram?: number;
  fetchedAt: Date;
};

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('goldPrice');
  return {
    sgeSymbol: cfg.get<string>('sgeSymbol', 'Au99.99'),
    refreshSeconds: cfg.get<number>('refreshSeconds', 60),
    showInternational: cfg.get<boolean>('showInternational', true),
    showInternationalCny: cfg.get<boolean>('showInternationalCny', true),
  };
}

function parseLastNonZeroQuote(q: SgeQuote): number | undefined {
  // q.data is a list of prices; take last non-zero
  for (let i = q.data.length - 1; i >= 0; i--) {
    const v = Number(q.data[i]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
  }
  return await res.text();
}

async function fetchSgeQuote(symbol: string): Promise<{ price?: number; updateText?: string }> {
  // SGE is sensitive to request shape. POST with form data + browser-ish headers works.
  const body = new URLSearchParams({ instid: symbol }).toString();
  // NOTE: SGE endpoint is sometimes protected by bot/WAF rules.
  // Empirically, a GET request with a body (as used by akshare) is more reliable than a plain POST.
  const text = await fetchText('https://www.sge.com.cn/graph/quotations', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.sge.com.cn/',
      'Origin': 'https://www.sge.com.cn',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body,
  });

  const json = JSON.parse(text) as SgeQuote;
  return {
    price: parseLastNonZeroQuote(json),
    updateText: json.delaystr,
  };
}

function parseStooqCsvClose(csv: string): number | undefined {
  // Example:
  // Symbol,Date,Time,Close\r\nUSDCNY,2026-03-18,02:55:16,6.88605\r\n
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;
  const header = lines[0].split(',');
  const idxClose = header.findIndex((h) => h.toLowerCase() === 'close');
  if (idxClose < 0) return undefined;
  const row = lines[1].split(',');
  const v = Number(row[idxClose]);
  return Number.isFinite(v) ? v : undefined;
}

async function fetchStooqClose(symbol: string): Promise<number | undefined> {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2c&h&e=csv`;
  const csv = await fetchText(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/csv,*/*',
    },
  });
  return parseStooqCsvClose(csv);
}

function formatNum(n: number, digits: number): string {
  return n.toFixed(digits);
}

function renderStatus(s: GoldSnapshot): string {
  const parts: string[] = [];
  if (s.sgePriceCnyPerGram != null) {
    parts.push(`${s.sgeSymbol}: ${formatNum(s.sgePriceCnyPerGram, 2)}¥/g`);
  } else {
    parts.push(`${s.sgeSymbol}: --`);
  }

  const cfg = getConfig();
  if (cfg.showInternational) {
    if (s.xauUsdPerOz != null) {
      let p = `XAUUSD: ${formatNum(s.xauUsdPerOz, 2)}$/oz`;
      if (cfg.showInternationalCny && s.xauCnyPerGram != null) {
        p += ` (≈ ${formatNum(s.xauCnyPerGram, 2)}¥/g)`;
      }
      parts.push(p);
    } else {
      parts.push('XAUUSD: --');
    }
  }

  return parts.join(' | ');
}

function renderTooltip(s: GoldSnapshot): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;

  md.appendMarkdown(`**Gold Price**\n\n`);
  md.appendMarkdown(`- SGE (${s.sgeSymbol}): ${s.sgePriceCnyPerGram != null ? formatNum(s.sgePriceCnyPerGram, 2) + ' ¥/g' : '--'}\n`);
  if (s.sgeUpdateText) md.appendMarkdown(`  - Update: ${s.sgeUpdateText}\n`);

  const cfg = getConfig();
  if (cfg.showInternational) {
    md.appendMarkdown(`- XAUUSD: ${s.xauUsdPerOz != null ? formatNum(s.xauUsdPerOz, 2) + ' $/oz' : '--'}\n`);
    if (cfg.showInternationalCny) {
      md.appendMarkdown(`- USDCNY: ${s.usdCny != null ? formatNum(s.usdCny, 5) : '--'}\n`);
      md.appendMarkdown(`- XAU (CNY/g): ${s.xauCnyPerGram != null ? formatNum(s.xauCnyPerGram, 2) : '--'}\n`);
    }
  }

  md.appendMarkdown(`\n_Last fetch: ${s.fetchedAt.toLocaleString()}_\n`);
  return md;
}

async function refreshSnapshot(): Promise<GoldSnapshot> {
  const cfg = getConfig();
  const fetchedAt = new Date();

  const snapshot: GoldSnapshot = {
    sgeSymbol: cfg.sgeSymbol,
    fetchedAt,
  };

  // Fetch in parallel
  const [sgeRes, xau, usdCny] = await Promise.all([
    fetchSgeQuote(cfg.sgeSymbol).catch((e) => {
      console.warn('[goldPrice] SGE fetch failed:', e);
      return { price: undefined, updateText: undefined };
    }),
    cfg.showInternational ? fetchStooqClose('xauusd') : Promise.resolve(undefined),
    cfg.showInternational && cfg.showInternationalCny ? fetchStooqClose('usdcny') : Promise.resolve(undefined),
  ]);

  snapshot.sgePriceCnyPerGram = sgeRes.price;
  snapshot.sgeUpdateText = sgeRes.updateText;
  snapshot.xauUsdPerOz = xau;
  snapshot.usdCny = usdCny;

  if (xau != null && usdCny != null) {
    snapshot.xauCnyPerGram = (xau * usdCny) / OZ_TO_GRAM;
  }

  return snapshot;
}

export function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'goldPrice.refresh';
  status.text = 'Gold: loading...';
  status.tooltip = 'Fetching gold prices...';
  status.show();

  let timer: NodeJS.Timeout | undefined;
  let lastSnapshot: GoldSnapshot | undefined;

  const doRefresh = async () => {
    try {
      status.text = 'Gold: refreshing...';
      const snap = await refreshSnapshot();
      lastSnapshot = snap;
      status.text = renderStatus(snap);
      status.tooltip = renderTooltip(snap);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      status.text = 'Gold: error (click to retry)';
      status.tooltip = msg;
      console.warn('[goldPrice] refresh error:', e);
    }
  };

  const schedule = () => {
    if (timer) clearInterval(timer);
    const { refreshSeconds } = getConfig();
    const ms = Math.max(10, refreshSeconds) * 1000;
    timer = setInterval(doRefresh, ms);
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('goldPrice.refresh', doRefresh),
    vscode.commands.registerCommand('goldPrice.copy', async () => {
      if (!lastSnapshot) return;
      await vscode.env.clipboard.writeText(renderStatus(lastSnapshot));
      vscode.window.setStatusBarMessage('Gold price copied', 1500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goldPrice')) {
        schedule();
        void doRefresh();
      }
    }),
    {
      dispose: () => {
        if (timer) clearInterval(timer);
      },
    },
  );

  schedule();
  void doRefresh();
}

export function deactivate() {}
