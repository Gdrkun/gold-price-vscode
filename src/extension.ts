import * as vscode from 'vscode';

const OZ_TO_GRAM = 31.1034768;

type SgeQuote = {
  heyue: string;
  times: string[];
  data: (string | number)[];
  delaystr: string; // e.g. "2026年03月18日 10:23:55"
};

type SgeDailyHq = {
  time: [string, number, number, number, number][]; // [date, open, close, low, high]
};

type GoldSnapshot = {
  sgeSymbol: string;

  // Domestic
  sgePriceCnyPerGram?: number;
  sgeUpdateText?: string;
  sgeIsFallback?: boolean;

  // International
  xauUsdPerOz?: number;
  usdCny?: number;
  xauCnyPerGram?: number;

  // Stooq direct XAUCNY (CNY per troy ounce). More stable conversion than multiplying XAUUSD*USDCNY.
  xauCnyPerOz?: number;

  fetchedAt: Date;
  errors: string[];
};

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('goldPrice');
  return {
    sgeSymbol: cfg.get<string>('sgeSymbol', 'Au99.99'),
    refreshSeconds: cfg.get<number>('refreshSeconds', 5),
    showInternational: cfg.get<boolean>('showInternational', true),
    internationalSource: cfg.get<'sina' | 'stooq'>('internationalSource', 'sina'),
    showInternationalCny: cfg.get<boolean>('showInternationalCny', true),
    emphasize: cfg.get<boolean>('emphasize', true),
    toastOnManualError: cfg.get<boolean>('toastOnManualError', true),
  };
}

function parseLastNonZeroQuote(q: SgeQuote): number | undefined {
  for (let i = q.data.length - 1; i >= 0; i--) {
    const v = Number(q.data[i]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

async function fetchText(url: string, init?: RequestInit, timeoutMs = 12_000): Promise<string> {
  const attempt = async (): Promise<string> => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      // Surface basic perf/availability signal in console for debugging.
      // (No user-visible noise; tooltip errors are handled elsewhere.)
      const elapsed = Date.now() - startedAt;
      if (elapsed > 2500) {
        console.warn(`[goldPrice] slow fetch ${elapsed}ms: ${url}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };

  // Lightweight retry for flaky networks / transient CDN issues.
  // IMPORTANT: do not retry on obvious WAF/forbidden responses (e.g. 403), it only slows down refresh.
  try {
    return await attempt();
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    if (/\bHTTP\s+403\b/.test(msg) || /\bHTTP\s+401\b/.test(msg)) {
      throw e;
    }
    // One retry with small delay.
    await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 300)));
    return await attempt();
  }
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 12_000): Promise<T> {
  const text = await fetchText(url, init, timeoutMs);
  return JSON.parse(text) as T;
}

async function fetchSgeIntraday(symbol: string): Promise<{ price?: number; updateText?: string }> {
  // SGE is sometimes protected by WAF rules. The "en" host is empirically more stable.
  const body = new URLSearchParams({ instid: symbol }).toString();
  const json = await fetchJson<SgeQuote>('https://en.sge.com.cn/graph/quotations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `https://en.sge.com.cn/h5_data_PriceChart?pro_name=${encodeURIComponent(symbol)}`,
      Origin: 'https://en.sge.com.cn',
      'User-Agent': 'Mozilla/5.0 (VSCode Extension; gold-price-vscode)',
    },
    body,
  });

  return {
    price: parseLastNonZeroQuote(json),
    updateText: json.delaystr,
  };
}

async function fetchSgeDailyClose(symbol: string): Promise<{ price?: number; updateText?: string }> {
  // Fallback: daily close from SGE (very stable, but not intraday).
  const body = new URLSearchParams({ instid: symbol }).toString();
  const json = await fetchJson<SgeDailyHq>('https://www.sge.com.cn/graph/Dailyhq', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.sge.com.cn/sjzx/mrhq',
      Origin: 'https://www.sge.com.cn',
      'User-Agent': 'Mozilla/5.0 (VSCode Extension; gold-price-vscode)',
    },
    body,
  });

  const last = json.time?.[json.time.length - 1];
  if (!last) return {};
  const date = last[0];
  const close = Number(last[2]);
  return {
    price: Number.isFinite(close) ? close : undefined,
    updateText: `Daily close: ${date}`,
  };
}

function parseStooqCsvClose(csv: string): number | undefined {
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
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2c&h&e=csv&t=${Date.now()}`;
  const csv = await fetchText(
    url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (VSCode Extension; gold-price-vscode)',
        Accept: 'text/csv,*/*',
      },
    },
    10_000,
  );
  return parseStooqCsvClose(csv);
}

async function fetchStooqManyClose(symbols: string[]): Promise<Record<string, number | undefined>> {
  // Stooq supports comma-separated symbols, which reduces rate-limit risk.
  // HOWEVER: in some environments the multi-symbol endpoint returns "N/D".
  // We'll detect that and fall back to per-symbol requests.
  const s = symbols.map((x) => x.trim()).filter(Boolean);
  if (!s.length) return {};

  const url = `https://stooq.com/q/l/?s=${s.map(encodeURIComponent).join(',')}&f=sd2t2c&h&e=csv&t=${Date.now()}`;
  const csv = await fetchText(
    url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (VSCode Extension; gold-price-vscode)',
        Accept: 'text/csv,*/*',
      },
    },
    10_000,
  );

  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return {};
  const header = lines[0].split(',');
  const idxSymbol = header.findIndex((h) => h.toLowerCase() === 'symbol');
  const idxClose = header.findIndex((h) => h.toLowerCase() === 'close');
  if (idxSymbol < 0 || idxClose < 0) return {};

  const out: Record<string, number | undefined> = {};
  let anyGood = false;
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const sym = (row[idxSymbol] ?? '').trim().toLowerCase();
    const rawClose = (row[idxClose] ?? '').trim();
    const close = Number(rawClose);
    const val = Number.isFinite(close) ? close : undefined;
    out[sym] = val;
    if (val != null) anyGood = true;
  }

  if (anyGood) return out;

  // Fallback: single-symbol requests (more reliable, slightly more requests).
  const fallback: Record<string, number | undefined> = {};
  await Promise.all(
    s.map(async (sym) => {
      try {
        fallback[sym.toLowerCase()] = await fetchStooqClose(sym);
      } catch {
        fallback[sym.toLowerCase()] = undefined;
      }
    }),
  );
  return fallback;
}

function parseSinaVarLine(line: string): { name: string; values: string[] } | undefined {
  // e.g. var hq_str_hf_XAU="4994.29,...,伦敦金（现货黄金）";
  const m = line.match(/^var\s+hq_str_(\w+)="([\s\S]*)";\s*$/);
  if (!m) return undefined;
  const name = m[1];
  const raw = m[2];
  return { name, values: raw.split(',') };
}

async function fetchSinaQuotes(names: string[]): Promise<Record<string, string[]>> {
  const url = `https://hq.sinajs.cn/list=${names.map(encodeURIComponent).join(',')}&t=${Date.now()}`;
  const text = await fetchText(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (VSCode Extension; gold-price-vscode)',
      Referer: 'https://finance.sina.com.cn/',
      Accept: 'application/javascript,text/plain,*/*',
    },
  });

  // Sina responds in GB18030. Node fetch doesn't auto-decode; but in practice many environments still decode.
  // If decoding issues occur, we'll still be able to parse numeric fields.
  const out: Record<string, string[]> = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = parseSinaVarLine(line);
    if (parsed) out[parsed.name] = parsed.values;
  }
  return out;
}

async function fetchSinaFxLast(symbol: 'fx_sxauusd' | 'fx_susdcny'): Promise<number | undefined> {
  const map = await fetchSinaQuotes([symbol]);
  const v = map[symbol];
  if (!v || v.length < 4) return undefined;
  const last = Number(v[3]);
  return Number.isFinite(last) ? last : undefined;
}

function formatNum(n: number, digits: number): string {
  return n.toFixed(digits);
}

function renderStatus(s: GoldSnapshot): string {
  const parts: string[] = [];

  if (s.sgePriceCnyPerGram != null) {
    const tag = s.sgeIsFallback ? ' (≈Intl)' : '';
    parts.push(`${s.sgeSymbol}: ${formatNum(s.sgePriceCnyPerGram, 2)}¥/g${tag}`);
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
  md.appendMarkdown(
    `- SGE (${s.sgeSymbol}): ${s.sgePriceCnyPerGram != null ? formatNum(s.sgePriceCnyPerGram, 2) + ' ¥/g' : '--'}${s.sgeIsFallback ? ' _(fallback from international)_' : ''}\n`,
  );
  if (s.sgeUpdateText) md.appendMarkdown(`  - Update: ${s.sgeUpdateText}\n`);

  const cfg = getConfig();
  if (cfg.showInternational) {
    md.appendMarkdown(`- XAUUSD: ${s.xauUsdPerOz != null ? formatNum(s.xauUsdPerOz, 2) + ' $/oz' : '--'}\n`);
    if (cfg.showInternationalCny) {
      md.appendMarkdown(`- USDCNY: ${s.usdCny != null ? formatNum(s.usdCny, 5) : '--'}\n`);
      if (s.xauCnyPerOz != null) md.appendMarkdown(`- XAUCNY: ${formatNum(s.xauCnyPerOz, 2)} ¥/oz\n`);
      md.appendMarkdown(`- XAU (CNY/g): ${s.xauCnyPerGram != null ? formatNum(s.xauCnyPerGram, 2) : '--'}\n`);
    }
  }

  if (s.errors.length) {
    md.appendMarkdown(`\n---\n**Errors (latest refresh)**\n`);
    for (const e of s.errors.slice(0, 5)) md.appendMarkdown(`- ${e}\n`);
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
    errors: [],
  };

  // Fetch SGE + International in parallel to reduce total refresh latency.
  const sgeTask = (async () => {
    // SGE (try intraday first, fallback to daily close)
    try {
      const sge = await fetchSgeIntraday(cfg.sgeSymbol);
      snapshot.sgePriceCnyPerGram = sge.price;
      snapshot.sgeUpdateText = sge.updateText;

      if (snapshot.sgePriceCnyPerGram == null) {
        snapshot.errors.push('SGE intraday returned no usable price');
        const daily = await fetchSgeDailyClose(cfg.sgeSymbol);
        snapshot.sgePriceCnyPerGram = daily.price;
        snapshot.sgeUpdateText = daily.updateText;
        if (snapshot.sgePriceCnyPerGram == null) snapshot.errors.push('SGE daily close returned no usable price');
      }
    } catch (e: any) {
      snapshot.errors.push(`SGE fetch failed: ${e?.message ? String(e.message) : String(e)}`);
      try {
        const daily = await fetchSgeDailyClose(cfg.sgeSymbol);
        snapshot.sgePriceCnyPerGram = daily.price;
        snapshot.sgeUpdateText = daily.updateText;
        if (snapshot.sgePriceCnyPerGram == null) snapshot.errors.push('SGE daily close returned no usable price');
      } catch (e2: any) {
        snapshot.errors.push(`SGE daily close failed: ${e2?.message ? String(e2.message) : String(e2)}`);
      }
    }
  })();

  const intlTask = (async () => {
    // International (never fail the whole refresh)
    if (!cfg.showInternational) return;

    const source = cfg.internationalSource;

    if (source === 'sina') {
      // Prefer batching into ONE request to reduce latency and WAF risk.
      const want = ['fx_sxauusd', cfg.showInternationalCny ? 'fx_susdcny' : null].filter((x): x is string => !!x);
      try {
        const map = await fetchSinaQuotes(want);

        const xau = map['fx_sxauusd'];
        if (xau && xau.length >= 4) {
          const last = Number(xau[3]);
          snapshot.xauUsdPerOz = Number.isFinite(last) ? last : undefined;
        }
        if (snapshot.xauUsdPerOz == null) snapshot.errors.push('Sina XAUUSD returned no usable price');

        if (cfg.showInternationalCny) {
          const fx = map['fx_susdcny'];
          if (fx && fx.length >= 4) {
            const last = Number(fx[3]);
            snapshot.usdCny = Number.isFinite(last) ? last : undefined;
          }
          if (snapshot.usdCny == null) snapshot.errors.push('Sina USDCNY returned no usable price');
        }
      } catch (e: any) {
        snapshot.errors.push(`Sina fetch failed: ${e?.message ? String(e.message) : String(e)}`);

        // Fallback to stooq single-symbol requests (more reliable across networks).
        try {
          snapshot.xauUsdPerOz = await fetchStooqClose('xauusd');
        } catch {}

        if (cfg.showInternationalCny) {
          try {
            snapshot.usdCny = await fetchStooqClose('usdcny');
          } catch {}
          try {
            snapshot.xauCnyPerOz = await fetchStooqClose('xaucny');
          } catch {}
        }
      }
    } else {
      // Stooq supports multi-symbol CSV; fetch in one request when possible.
      try {
        const want = ['xauusd', cfg.showInternationalCny ? 'usdcny' : null, cfg.showInternationalCny ? 'xaucny' : null]
          .filter((x): x is string => !!x);
        const map = await fetchStooqManyClose(want);

        snapshot.xauUsdPerOz = map['xauusd'];
        if (snapshot.xauUsdPerOz == null) snapshot.errors.push('XAUUSD returned no usable price');

        if (cfg.showInternationalCny) {
          snapshot.usdCny = map['usdcny'];
          if (snapshot.usdCny == null) snapshot.errors.push('USDCNY returned no usable price');

          snapshot.xauCnyPerOz = map['xaucny'];
          // xauCnyPerGram computed later (prefers direct XAUCNY).
        }
      } catch (e: any) {
        snapshot.errors.push(`Stooq fetch failed: ${e?.message ? String(e.message) : String(e)}`);
      }
    }

    // Prefer XAUCNY direct when available (avoids cross-source FX mismatch).
    if (snapshot.xauCnyPerOz != null) {
      snapshot.xauCnyPerGram = snapshot.xauCnyPerOz / OZ_TO_GRAM;
    } else if (snapshot.xauUsdPerOz != null && snapshot.usdCny != null) {
      snapshot.xauCnyPerGram = (snapshot.xauUsdPerOz * snapshot.usdCny) / OZ_TO_GRAM;
    }
  })();

  await Promise.allSettled([sgeTask, intlTask]);

  // Final fallback: if SGE is unavailable, show international CNY/g as a stable domestic approximation.
  if (snapshot.sgePriceCnyPerGram == null && snapshot.xauCnyPerGram != null) {
    snapshot.sgePriceCnyPerGram = snapshot.xauCnyPerGram;
    snapshot.sgeUpdateText = `Fallback: Intl (via ${cfg.internationalSource}${snapshot.xauCnyPerOz != null ? ' XAUCNY' : ' XAUUSD×USDCNY'})`;
    snapshot.sgeIsFallback = true;
    snapshot.errors.push('SGE unavailable; using international CNY/g fallback');
  }

  return snapshot;
}

type VisualState = 'loading' | 'ok' | 'warning' | 'error';

function applyVisual(status: vscode.StatusBarItem, state: VisualState) {
  const cfg = getConfig();
  if (!cfg.emphasize) {
    status.backgroundColor = undefined;
    status.color = undefined;
    return;
  }

  switch (state) {
    case 'loading':
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      status.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
      return;
    case 'ok':
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      status.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
      return;
    case 'warning':
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      status.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      return;
    case 'error':
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      status.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      return;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'goldPrice.refresh';
  status.text = '$(pulse) Gold: loading...';
  status.tooltip = 'Fetching gold prices...';
  applyVisual(status, 'loading');
  status.show();

  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let lastGood: GoldSnapshot | undefined;

  const updateFromSnapshot = (snap: GoldSnapshot, state: VisualState) => {
    const prefix = state === 'error' ? '$(error) ' : state === 'warning' ? '$(warning) ' : '$(pulse) ';
    status.text = prefix + renderStatus(snap);
    status.tooltip = renderTooltip(snap);
    applyVisual(status, state);
  };

  const doRefresh = async (manual: boolean) => {
    if (inFlight) return;
    inFlight = true;

    try {
      // Keep last good value visible while refreshing.
      if (lastGood) {
        updateFromSnapshot({ ...lastGood, errors: [] }, 'loading');
      } else {
        status.text = '$(sync~spin) Gold: refreshing...';
        applyVisual(status, 'loading');
      }

      const snap = await refreshSnapshot();

      const hasAny = snap.sgePriceCnyPerGram != null || snap.xauUsdPerOz != null;
      const hasError = snap.errors.length > 0;

      if (hasAny) {
        lastGood = snap;
        updateFromSnapshot(snap, hasError ? 'warning' : 'ok');
      } else {
        // No usable data; keep lastGood if available.
        if (lastGood) {
          updateFromSnapshot({ ...lastGood, errors: snap.errors }, 'error');
        } else {
          updateFromSnapshot(snap, 'error');
        }
      }

      const cfg = getConfig();
      if (manual && cfg.toastOnManualError && snap.errors.length) {
        void vscode.window.showWarningMessage(`Gold Price: ${snap.errors[0]}`);
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      const snap: GoldSnapshot = lastGood
        ? { ...lastGood, fetchedAt: new Date(), errors: [msg] }
        : { sgeSymbol: getConfig().sgeSymbol, fetchedAt: new Date(), errors: [msg] };
      updateFromSnapshot(snap, 'error');
      if (manual) void vscode.window.showErrorMessage(`Gold Price: ${msg}`);
      console.warn('[goldPrice] refresh crash:', e);
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (timer) clearInterval(timer);
    const { refreshSeconds } = getConfig();
    const ms = Math.max(1, refreshSeconds) * 1000;
    timer = setInterval(() => void doRefresh(false), ms);
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('goldPrice.refresh', () => void doRefresh(true)),
    vscode.commands.registerCommand('goldPrice.copy', async () => {
      if (!lastGood) return;
      await vscode.env.clipboard.writeText(renderStatus(lastGood));
      vscode.window.setStatusBarMessage('Gold price copied', 1500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goldPrice')) {
        schedule();
        void doRefresh(false);
      }
    }),
    {
      dispose: () => {
        if (timer) clearInterval(timer);
      },
    },
  );

  schedule();
  void doRefresh(false);
}

export function deactivate() {}
