import { Alert, Box, Grid, List, ListItem, ListItemText, Paper, Typography } from '@mui/material';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TodayIcon from '@mui/icons-material/Today';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../AppState';
import { call, central } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { money, qty } from '../lib/format';
import { ErrorAlert, Loading, PageHeader, StatCard } from '../components/common';

const rupees = (p: number) => Math.round(Number(p) / 100);
const compact = (v: number) => (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`);

export function DashboardPage() {
  const { info, can } = useApp();
  const nav = useNavigate();
  const local = useAsync(() => call('reports.dashboard'), []);
  const online = !!info?.session?.online;
  const consolidated = useAsync(async () => (online && can('reports.view') ? central<any>('GET', '/api/reports/dashboard') : null), [online]);

  const d = local.data;
  return (
    <Box>
      <PageHeader title="Dashboard" subtitle={`${info?.location?.name} — figures from this computer are live even when offline`} />
      <ErrorAlert error={local.error} onRetry={local.reload} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            {info?.location?.type === 'BRANCH' && (
              <>
                <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                  <StatCard icon={<TodayIcon />} label="Today's sales" value={money(d.today.total)} hint={`${d.today.invoices} invoices · returns ${money(d.today.returns)}`} />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                  <StatCard icon={<TrendingUpIcon />} color="#0288d1" label="Last 7 / 30 days" value={money(d.week)} hint={`30 days: ${money(d.month)}`} />
                </Grid>
              </>
            )}
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard icon={<Inventory2Icon />} color="#2e7d32" label="Stock at this location" value={money(d.stock.value)} hint={`${qty(d.stock.qty)} units at cost`} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard icon={<WarningAmberIcon />} color="#ed6c02" label="Low stock items" value={d.stock.lowCount} hint="At or below reorder level" />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard icon={<ShoppingCartIcon />} color="#6a1b9a" label="Purchases (30 days)" value={money(d.purchasesMonth)} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                icon={<LocalShippingIcon />}
                color="#00838f"
                label="Transfers needing action"
                value={(d.transfers.toApprove ?? 0) + (d.transfers.toDispatch ?? 0) + (d.transfers.toReceive ?? 0)}
                hint={`approve ${d.transfers.toApprove} · dispatch ${d.transfers.toDispatch} · receive ${d.transfers.toReceive}`}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                icon={<CloudSyncIcon />}
                color={d.sync.failed ? '#c62828' : '#455a64'}
                label="Pending synchronisation"
                value={d.sync.pending}
                hint={d.sync.failed ? `${d.sync.failed} failed — open Synchronisation` : 'transactions waiting to upload'}
              />
            </Grid>
          </Grid>

          {info?.location?.type === 'BRANCH' && (
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid size={{ xs: 12, lg: 8 }}>
                <Paper sx={{ p: 2, height: 320 }}>
                  <Typography variant="subtitle1" sx={{ mb: 1 }}>
                    Sales — last 30 days
                  </Typography>
                  <ResponsiveContainer width="100%" height="88%">
                    <AreaChart data={(d.salesByDay as { day: string; total: number }[]).map((x) => ({ day: x.day.slice(5), total: rupees(x.total) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e3e8f0" />
                      <XAxis dataKey="day" fontSize={12} />
                      <YAxis tickFormatter={compact} fontSize={12} width={60} />
                      <Tooltip formatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} />
                      <Area type="monotone" dataKey="total" name="Sales" stroke="#1565c0" fill="#90caf9" />
                    </AreaChart>
                  </ResponsiveContainer>
                </Paper>
              </Grid>
              <Grid size={{ xs: 12, lg: 4 }}>
                <Paper sx={{ p: 2, height: 320, overflow: 'auto' }}>
                  <Typography variant="subtitle1">Top products (30 days)</Typography>
                  <List dense>
                    {(d.topProducts as { name: string; qty: number; total: number }[]).map((p) => (
                      <ListItem key={p.name} secondaryAction={<Typography variant="body2">{money(p.total)}</Typography>}>
                        <ListItemText primary={p.name} secondary={`${p.qty} sold`} />
                      </ListItem>
                    ))}
                  </List>
                  <Typography variant="subtitle1" sx={{ mt: 1 }}>
                    Today by payment method
                  </Typography>
                  {(d.byPayment as { method: string; total: number }[]).map((p) => (
                    <Typography key={p.method} variant="body2">
                      {p.method}: {money(p.total)}
                    </Typography>
                  ))}
                </Paper>
              </Grid>
            </Grid>
          )}
        </>
      )}

      {can('reports.view') && (
        <Box>
          <Typography variant="h6" sx={{ mb: 1, mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <CompareArrowsIcon /> Company-wide (central server)
          </Typography>
          {!online ? (
            <Alert severity="info">Consolidated figures for all warehouses and branches appear here when signed in online.</Alert>
          ) : consolidated.error ? (
            <ErrorAlert error={consolidated.error} onRetry={consolidated.reload} />
          ) : !consolidated.data ? (
            <Loading />
          ) : (
            <ConsolidatedSection data={consolidated.data} onOpenRecon={() => nav('/transfers?tab=reconciliation')} />
          )}
        </Box>
      )}
    </Box>
  );
}

function ConsolidatedSection({ data, onOpenRecon }: { data: any; onOpenRecon: () => void }) {
  const stock = (data.stockByLocation as { name: string; type: string; value: number; qty: number }[]).map((l) => ({ ...l, value: rupees(l.value) }));
  return (
    <>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard label={`Sales ${data.range.from} → ${data.range.to}`} value={money(data.sales.total)} hint={`${data.sales.invoices} invoices · tax ${money(data.sales.tax)}`} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard label="Purchases (GRN)" value={money(data.purchases.total)} hint={`${data.purchases.count} receipts`} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard label="Total stock (all locations)" value={money(data.totalStock.value)} hint={`${qty(data.totalStock.qty)} units · ${data.lowStockCount} low`} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <Box onClick={onOpenRecon} sx={{ cursor: 'pointer', height: '100%' }}>
            <StatCard
              label="Needs review"
              value={data.openReconciliation}
              hint={`${data.sync.pending} unsynced on ${data.sync.devices} PCs · ${data.sync.offlineDevices} offline · ${data.sync.rejected} rejected`}
            />
          </Box>
        </Grid>
      </Grid>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Paper sx={{ p: 2, height: 320 }}>
            <Typography variant="subtitle1">Stock value by warehouse / branch</Typography>
            <ResponsiveContainer width="100%" height="88%">
              <BarChart data={stock}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e3e8f0" />
                <XAxis dataKey="name" fontSize={12} />
                <YAxis tickFormatter={compact} fontSize={12} width={60} />
                <Tooltip formatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} />
                <Legend />
                <Bar dataKey="value" name="Stock value (cost)" fill="#1565c0" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          <Paper sx={{ p: 2, height: 320, overflow: 'auto' }}>
            <Typography variant="subtitle1">Branch-wise sales</Typography>
            <List dense>
              {(data.salesByBranch as { locationId: string; name: string; total: number; invoices: number }[]).map((b) => (
                <ListItem key={b.locationId} secondaryAction={<Typography>{money(b.total)}</Typography>}>
                  <ListItemText primary={b.name} secondary={`${b.invoices} invoices`} />
                </ListItem>
              ))}
            </List>
            <Typography variant="subtitle1">Pending transfers</Typography>
            {(data.pendingTransfers as { status: string; n: number }[]).map((t) => (
              <Typography key={t.status} variant="body2">
                {t.status.replace(/_/g, ' ').toLowerCase()}: {t.n}
              </Typography>
            ))}
          </Paper>
        </Grid>
      </Grid>
    </>
  );
}
