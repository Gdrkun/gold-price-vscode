# Gold Price (SGE + XAUUSD) — VS Code Status Bar

A small VS Code extension that shows:

- **Domestic CN**: Shanghai Gold Exchange (**SGE**) spot price (default: `Au99.99`, CNY/gram)
- **International**: `XAUUSD` (USD/oz) + optional CNY/gram conversion using `USDCNY`

## Features

- Status bar item (bottom bar) updates on an interval
- Manual refresh command
- Configurable SGE symbol + refresh interval

## Data sources

- SGE: `https://www.sge.com.cn/graph/quotations` (POST)
- XAUUSD + USDCNY: Stooq CSV

## Development

```bash
npm i
npm run compile
# in VS Code: Run Extension (F5)
```

## Packaging

```bash
npm run package
# outputs .vsix
```
