import { Navigate, Route, Routes } from 'react-router-dom';
import { Box } from '@mui/material';
import { useApp } from './AppState';
import { Layout } from './components/Layout';
import { Loading } from './components/common';
import { SetupPage } from './pages/SetupPage';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { PosPage } from './pages/PosPage';
import { SalesPage } from './pages/SalesPage';
import { ProductsPage } from './pages/ProductsPage';
import { StockPage } from './pages/StockPage';
import { TransfersPage } from './pages/TransfersPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { SuppliersPage } from './pages/SuppliersPage';
import { CustomersPage } from './pages/CustomersPage';
import { ReportsPage } from './pages/ReportsPage';
import { SyncPage } from './pages/SyncPage';
import { AdminPage } from './pages/AdminPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const { info, can } = useApp();
  if (!info) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <Loading label="Starting Store Manager…" />
      </Box>
    );
  }
  if (!info.device) return <SetupPage />;
  if (!info.session) return <LoginPage />;

  // Users without dashboard access (e.g. POS staff) land on the POS.
  const home = can('dashboard.view') ? <DashboardPage /> : can('pos.sell') ? <Navigate to="/pos" replace /> : <Navigate to="/stock" replace />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/pos" element={<PosPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/stock" element={<StockPage />} />
        <Route path="/transfers" element={<TransfersPage />} />
        <Route path="/purchases" element={<PurchasesPage />} />
        <Route path="/suppliers" element={<SuppliersPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
