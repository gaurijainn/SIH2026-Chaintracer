Synthetic complaint data only (no real victim data).

- `complaints_demo.csv`: the demo intake of five complaints (three TRON, one EVM with no network so the chain is probed, one Bitcoin).
- `complaint_linked.json`: a sixth complaint that reuses a wallet from DEMO-0001, so it auto-links to the same case (`POST /api/v1/complaints`).

The EVM probe responses for the demo address are shipped as replay fixtures (`pnpm fixtures:seed`), so the demo also works offline.
