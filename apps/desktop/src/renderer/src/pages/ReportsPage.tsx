import { useMemo, useState } from 'react';
import { Alert, Box, Button, MenuItem, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, money, qty, rate, toCsv, todayIso } from '../lib/format';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorAlert, OnlineRequired, PageHeader } from '../components/common';

const MONEY_KEYS = new Set([
  'taxable', 'tax', 'total', 'discount', 'cgst', 'sgst', 'igst', 'collected', 'refunded', 'margin', 'costValue', 'retailValue', 'refundTotal', 'value',
]);

/** Build columns from row keys: money fields formatted in ₹, rates as %, counts as numbers. */
function autoColumns(rows: Record<string, unknown>[], labels: Record<string, string> = {}, hide: string[] = ['id']): Column<any>[] {
  const keys = Object.keys(rows[0] ?? {}).filter((k) => !hide.includes(k));
  return keys.map((k) => ({
    key: k,
    label: labels[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    align: MONEY_KEYS.has(k) || typeof rows[0][k] === 'number' || k === 'rateBp' ? ('right' as const) : undefined,
    value: (r: any) => (MONEY_KEYS.has(k) || k === 'rateBp' || typeof r[k] === 'number' ? Number(r[k]) : r[k]),
    render: (r: any) =>
      MONEY_KEYS.has(k) ? money(r[k]) : k === 'rateBp' ? rate(r[k]) : /At$/.test(k) && r[k] ? dateTime(r[k]) : typeof r[k] === 'number' ? qty(r[k]) : String(r[k] ?? ''),
  }));
}

function ReportTable({ title, rows, labels, name }: { title?: string; rows: Record<string, unknown>[]; labels?: Record<string, string>; name: string }) {
  const { notify } = useApp();
  const columns = useMemo(() => autoColumns(rows, labels), [rows, labels]);
  const exportCsv = async () => {
    // Money columns are exported in rupees with 2 decimals.
    const data = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, MONEY_KEYS.has(k) ? (Number(v) / 100).toFixed(2) : k === 'rateBp' ? Number(v) / 100 : v])));
    try {
      const res = await call('app.saveCsv', { name: `${name}.csv`, content: toCsv(data, columns.map((c) => ({ key: c.key, label: c.label }))) });
      if (res.saved) notify(`Saved ${res.path}`);
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  return (
    <Box sx={{ mb: 2 }}>
      {title && (
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          {title}
        </Typography>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r: any) => String(r.id ?? r.key ?? JSON.stringify(r))}
        toolbar={
          <Button size="small" startIcon={<DownloadIcon />} onClick={exportCsv} disabled={!rows.length}>
            Export CSV
          </Button>
        }
      />
    </Box>
  );
}

export function ReportsPage() {
  const { can } = useApp();
  const [scope, setScope] = useState<'local' | 'company'>('local');
  const [from, setFrom] = useState(todayIso(-29));
  const [to, setTo] = useState(todayIso());
  return (
    <Box>
      <PageHeader
        title="Reports & analytics"
        actions={
          <Stack direction="row" spacing={1}>
            <TextField type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
        }
      />
      <Tabs value={scope} onChange={(_e, v) => setScope(v)} sx={{ mb: 2 }}>
        <Tab value="local" label="This location (offline)" />
        <Tab value="company" label={can('reports.consolidated') ? 'Company-wide (central)' : 'My locations (central)'} />
      </Tabs>
      {scope === 'local' ? <LocalReports from={from} to={to} /> : <CentralReports from={from} to={to} />}
    </Box>
  );
}

function LocalReports({ from, to }: { from: string; to: string }) {
  const { can } = useApp();
  const [kind, setKind] = useState<'day' | 'product' | 'payment' | 'user' | 'hsn' | 'gst'>('day');
  const data = useAsync(async () => {
    if (kind === 'gst') {
      const g = await call('reports.gst', { from, to });
      return { rows: g.rows as Record<string, unknown>[], input: g.input as { taxable: number; tax: number } };
    }
    return { rows: (await call('reports.sales', { from, to, groupBy: kind })).rows as Record<string, unknown>[], input: null };
  }, [kind, from, to]);
  return (
    <>
      <TextField select label="Report" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} sx={{ mb: 2, minWidth: 260 }}>
        <MenuItem value="day">Sales by day</MenuItem>
        <MenuItem value="product">Product-wise sales & margin</MenuItem>
        <MenuItem value="payment">Collections by payment method</MenuItem>
        <MenuItem value="user">Sales by cashier</MenuItem>
        <MenuItem value="hsn">HSN summary</MenuItem>
        {can('reports.gst') && <MenuItem value="gst">GST summary (output / input)</MenuItem>}
      </TextField>
      <ErrorAlert error={data.error} />
      {data.data && (
        <>
          {data.data.input && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Input tax on purchases (net of returns): {money(data.data.input.tax)} on taxable {money(data.data.input.taxable)}
            </Alert>
          )}
          <ReportTable rows={data.data.rows} name={`local-${kind}-${from}-${to}`} labels={{ key: kind === 'day' ? 'Date' : kind === 'product' ? 'SKU' : kind === 'hsn' ? 'HSN' : 'Name', rateBp: 'GST rate' }} />
        </>
      )}
    </>
  );
}

function CentralReports({ from, to }: { from: string; to: string }) {
  const { info, can } = useApp();
  const online = !!info?.session?.online;
  const locations = useAsync(() => call('catalog.locations'), []);
  const [locationId, setLocationId] = useState('');
  const [kind, setKind] = useState('sales-location');
  const user = info?.session?.user;
  const visibleLocations = (locations.data ?? []).filter((l) => user?.allLocations || user?.locationIds.includes(l.id));
  const q = `from=${from}&to=${to}${locationId ? `&locationId=${locationId}` : ''}`;

  const data = useAsync(async () => {
    if (!online) return null;
    switch (kind) {
      case 'sales-day':
      case 'sales-location':
      case 'sales-product':
      case 'sales-payment':
      case 'sales-user':
      case 'sales-invoice':
        return { tables: [{ rows: (await central('GET', `/api/reports/sales?${q}&groupBy=${kind.split('-')[1]}`)).rows }] };
      case 'gst': {
        const g = await central('GET', `/api/reports/gst?${q}`);
        return {
          note: `Input tax (purchases net of returns): ${money(g.inputTax.tax)} on taxable ${money(g.inputTax.taxable)}`,
          tables: [
            { title: 'Outward supplies by rate (sales less returns)', rows: g.byRate },
            { title: 'HSN summary', rows: g.byHsn },
            { title: 'By location / GSTIN', rows: g.byLocation },
          ],
        };
      }
      case 'stock': {
        const s = await central('GET', `/api/reports/stock-valuation${locationId ? `?locationId=${locationId}` : ''}`);
        return { tables: [{ title: 'By warehouse / branch', rows: s.byLocation }, { title: 'By category', rows: s.byCategory }] };
      }
      case 'purchases': {
        const p = await central('GET', `/api/reports/purchases?${q}`);
        return { tables: [{ title: 'By supplier', rows: p.bySupplier }, { title: 'By receiving location', rows: p.byLocation }] };
      }
      case 'transfers':
        return { tables: [{ rows: (await central('GET', `/api/reports/transfers?${q}`)).rows }] };
      case 'returns':
        return { tables: [{ rows: (await central('GET', `/api/reports/returns?${q}`)).rows }] };
      case 'audit':
        return { tables: [{ rows: (await central('GET', `/api/audit-logs?limit=500${locationId ? `&locationId=${locationId}` : ''}`)).map((a: any) => ({ ...a, details: JSON.stringify(a.details) })) }] };
    }
    return null;
  }, [online, kind, q]);

  return (
    <OnlineRequired online={online}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Report" value={kind} onChange={(e) => setKind(e.target.value)} sx={{ minWidth: 280 }}>
          <MenuItem value="sales-location">Branch-wise sales</MenuItem>
          <MenuItem value="sales-day">Consolidated sales by day</MenuItem>
          <MenuItem value="sales-product">Product-wise sales & margin</MenuItem>
          <MenuItem value="sales-payment">Collections by payment method</MenuItem>
          <MenuItem value="sales-user">Sales by user</MenuItem>
          <MenuItem value="sales-invoice">Invoice register</MenuItem>
          {can('reports.gst') && <MenuItem value="gst">GST (GSTR-1 style summary)</MenuItem>}
          <MenuItem value="stock">Stock valuation (warehouse & branch-wise)</MenuItem>
          {can('purchase.view') && <MenuItem value="purchases">Purchases</MenuItem>}
          <MenuItem value="transfers">Stock transfers</MenuItem>
          <MenuItem value="returns">Returns & refunds</MenuItem>
          {can('audit.view') && <MenuItem value="audit">User activity & audit log</MenuItem>}
        </TextField>
        <TextField select slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }} label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)} sx={{ minWidth: 240 }}>
          <MenuItem value="">{user?.allLocations ? 'All locations (consolidated)' : 'All my locations'}</MenuItem>
          {visibleLocations.map((l) => (
            <MenuItem key={l.id} value={l.id}>
              {l.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'} — {l.name}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <ErrorAlert error={data.error} onRetry={data.reload} />
      {data.data?.note && <Alert severity="info" sx={{ mb: 2 }}>{data.data.note}</Alert>}
      {(data.data?.tables ?? []).map((t: { title?: string; rows: any[] }, i: number) => (
        <ReportTable key={`${kind}-${i}`} title={t.title} rows={t.rows} name={`${kind}-${from}-${to}-${i}`} labels={{ key: kind === 'sales-day' ? 'Date' : kind === 'sales-invoice' ? 'Invoice' : 'Name', rateBp: 'GST rate' }} />
      ))}
      {data.loading && !data.data && <Paper sx={{ p: 3 }}>Loading…</Paper>}
    </OnlineRequired>
  );
}
