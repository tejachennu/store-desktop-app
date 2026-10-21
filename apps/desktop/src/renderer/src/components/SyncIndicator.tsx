import { Badge, Chip, Tooltip } from '@mui/material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import SyncIcon from '@mui/icons-material/Sync';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../AppState';
import { relative } from '../lib/format';

/** Always-visible online/offline + pending-sync indicator. */
export function SyncIndicator() {
  const { sync } = useApp();
  const nav = useNavigate();
  if (!sync) return null;
  const offline = sync.state === 'offline' || sync.state === 'unregistered';
  const icon =
    sync.state === 'syncing' ? <SyncIcon sx={{ animation: 'spin 1.2s linear infinite', '@keyframes spin': { to: { transform: 'rotate(-360deg)' } } }} /> :
    sync.failed > 0 ? <ErrorOutlineIcon /> : offline ? <CloudOffIcon /> : <CloudDoneIcon />;
  const label = sync.state === 'syncing' ? 'Syncing…' : offline ? 'Offline' : sync.state === 'error' ? 'Sync error' : 'Online';
  const color = sync.failed > 0 || sync.state === 'error' ? 'error' : offline ? 'warning' : 'success';
  const tip = [
    offline ? 'Working offline — all sales and stock operations are saved on this computer.' : 'Connected to the central server.',
    `${sync.pending} pending, ${sync.failed} failed.`,
    `Last sync ${relative(sync.lastSyncAt)}.`,
    sync.lastError ? `Last error: ${sync.lastError}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Tooltip title={tip}>
      <Badge badgeContent={sync.pending + sync.failed} color={sync.failed ? 'error' : 'warning'} max={999}>
        <Chip icon={icon} label={label} color={color} variant="filled" onClick={() => nav('/sync')} sx={{ color: '#fff', fontWeight: 600 }} />
      </Badge>
    </Tooltip>
  );
}
