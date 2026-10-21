import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  AppBar,
  Avatar,
  Box,
  Chip,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PointOfSaleIcon from '@mui/icons-material/PointOfSale';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import WarehouseIcon from '@mui/icons-material/Warehouse';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PeopleIcon from '@mui/icons-material/People';
import AssessmentIcon from '@mui/icons-material/Assessment';
import SyncIcon from '@mui/icons-material/Sync';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import SettingsIcon from '@mui/icons-material/Settings';
import type { Permission } from '@store/shared';
import { ROLE_LABELS } from '@store/shared';
import { useApp } from '../AppState';
import { SyncIndicator } from './SyncIndicator';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { call } from '../lib/api';

const DRAWER = 236;

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm?: Permission;
  branchOnly?: boolean;
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Operations',
    items: [
      { to: '/', label: 'Dashboard', icon: <DashboardIcon />, perm: 'dashboard.view' },
      { to: '/pos', label: 'Point of Sale', icon: <PointOfSaleIcon />, perm: 'pos.sell', branchOnly: true },
      { to: '/sales', label: 'Sales & Returns', icon: <ReceiptLongIcon />, perm: 'sales.view' },
      { to: '/stock', label: 'Inventory', icon: <WarehouseIcon />, perm: 'stock.view' },
      { to: '/transfers', label: 'Stock Transfers', icon: <LocalShippingIcon />, perm: 'transfers.view' },
      { to: '/purchases', label: 'Purchases', icon: <ShoppingCartIcon />, perm: 'purchase.view' },
    ],
  },
  {
    title: 'Master data',
    items: [
      { to: '/products', label: 'Products', icon: <Inventory2Icon />, perm: 'products.view' },
      { to: '/suppliers', label: 'Suppliers', icon: <StorefrontIcon />, perm: 'suppliers.view' },
      { to: '/customers', label: 'Customers', icon: <PeopleIcon />, perm: 'customers.view' },
    ],
  },
  {
    title: 'Insights & admin',
    items: [
      { to: '/reports', label: 'Reports', icon: <AssessmentIcon />, perm: 'reports.view' },
      { to: '/sync', label: 'Synchronisation', icon: <SyncIcon /> },
      { to: '/admin', label: 'Administration', icon: <AdminPanelSettingsIcon />, perm: 'users.manage' },
      { to: '/settings', label: 'Settings & Backup', icon: <SettingsIcon /> },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { info, can, refresh } = useApp();
  const loc = useLocation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const user = info?.session?.user;
  const isBranch = info?.location?.type === 'BRANCH';

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1, bgcolor: 'primary.main' }}>
        <Toolbar sx={{ gap: 2 }}>
          <StorefrontIcon />
          <Typography variant="h6" sx={{ mr: 2 }}>
            {info?.settings.name ?? 'Store Manager'}
          </Typography>
          {info?.location && (
            <Chip
              label={`${info.location.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'}: ${info.location.name}`}
              sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: '#fff', fontWeight: 600 }}
            />
          )}
          {info?.session?.mode === 'offline' && <Chip size="small" label="Offline sign-in" sx={{ bgcolor: '#ffb74d', color: '#3e2723' }} />}
          <Box sx={{ flex: 1 }} />
          <SyncIndicator />
          <Chip
            avatar={<Avatar>{user?.fullName.slice(0, 1)}</Avatar>}
            label={`${user?.fullName ?? ''} · ${user ? ROLE_LABELS[user.role] : ''}`}
            onClick={(e) => setAnchor(e.currentTarget)}
            sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: '#fff' }}
          />
          <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
            <MenuItem
              onClick={() => {
                setAnchor(null);
                setPwOpen(true);
              }}
            >
              Change password
            </MenuItem>
            <MenuItem
              onClick={async () => {
                setAnchor(null);
                await call('auth.logout');
                await refresh();
              }}
            >
              Sign out
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" sx={{ width: DRAWER, flexShrink: 0, '& .MuiDrawer-paper': { width: DRAWER, boxSizing: 'border-box', borderRight: '1px solid #e3e8f0' } }}>
        <Toolbar />
        <Box sx={{ overflowY: 'auto' }}>
          {SECTIONS.map((section) => {
            const items = section.items.filter((i) => (!i.perm || can(i.perm)) && (!i.branchOnly || isBranch));
            if (items.length === 0) return null;
            return (
              <List key={section.title} dense subheader={<ListSubheader sx={{ lineHeight: '32px', bgcolor: 'transparent' }}>{section.title}</ListSubheader>}>
                {items.map((i) => {
                  const active = i.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(i.to);
                  return (
                    <ListItemButton key={i.to} component={NavLink} to={i.to} selected={active} sx={{ mx: 1, borderRadius: 1.5 }}>
                      <ListItemIcon sx={{ minWidth: 36, color: active ? 'primary.main' : undefined }}>{i.icon}</ListItemIcon>
                      <ListItemText primary={i.label} slotProps={{ primary: { fontWeight: active ? 600 : 400 } }} />
                    </ListItemButton>
                  );
                })}
              </List>
            );
          })}
          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ px: 2, display: 'block' }}>
            Device #{info?.device?.deviceNo} · {info?.location?.code}
          </Typography>
        </Box>
      </Drawer>
      <Box component="main" sx={{ flex: 1, p: 3, overflow: 'auto', bgcolor: 'background.default' }}>
        <Toolbar />
        {children}
      </Box>
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </Box>
  );
}
