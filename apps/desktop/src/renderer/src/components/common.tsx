import { useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  TextField,
  Typography,
  type ChipProps,
} from '@mui/material';
import { TRANSFER_STATUS_LABELS, type TransferStatus } from '@store/shared';
import { errorMessage } from '../lib/api';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
      <Box sx={{ flex: 1, minWidth: 200 }}>
        <Typography variant="h5">{title}</Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>{actions}</Box>
    </Box>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 4, justifyContent: 'center' }}>
      <CircularProgress size={24} />
      <Typography color="text.secondary">{label}</Typography>
    </Box>
  );
}

export function ErrorAlert({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert severity="error" sx={{ mb: 2 }} action={onRetry ? <Button color="inherit" size="small" onClick={onRetry}>Retry</Button> : undefined}>
      {error}
    </Alert>
  );
}

export function StatCard({ label, value, hint, color, icon }: { label: string; value: ReactNode; hint?: ReactNode; color?: string; icon?: ReactNode }) {
  return (
    <Paper sx={{ p: 2, display: 'flex', gap: 2, alignItems: 'center', height: '100%' }}>
      {icon && (
        <Box sx={{ width: 44, height: 44, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: color ?? 'primary.main', color: '#fff' }}>{icon}</Box>
      )}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" noWrap>
          {label}
        </Typography>
        <Typography variant="h6" noWrap>
          {value}
        </Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

const TRANSFER_COLORS: Record<TransferStatus, ChipProps['color']> = {
  REQUESTED: 'info',
  APPROVED: 'primary',
  REJECTED: 'default',
  PARTIALLY_DISPATCHED: 'warning',
  DISPATCHED: 'secondary',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CLOSED_WITH_DISCREPANCY: 'error',
  CANCELLED: 'default',
};

export function TransferStatusChip({ status }: { status: TransferStatus }) {
  return <Chip size="small" label={TRANSFER_STATUS_LABELS[status]} color={TRANSFER_COLORS[status]} variant={status === 'CANCELLED' || status === 'REJECTED' ? 'outlined' : 'filled'} />;
}

export function SyncChip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const color: ChipProps['color'] = status === 'SYNCED' ? 'success' : status === 'FAILED' ? 'error' : 'warning';
  const label = status === 'SYNCED' ? 'Synced' : status === 'FAILED' ? 'Sync failed' : 'Pending sync';
  return <Chip size="small" variant="outlined" color={color} label={label} />;
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, a reason must be typed before confirming. */
  requireReason?: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

/** Confirmation for destructive or irreversible actions; shows errors inline. */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, requireReason, onClose, onConfirm }: ConfirmProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setReason('');
    setError(null);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{message}</DialogContentText>
        {requireReason && (
          <TextField autoFocus fullWidth label={requireReason} value={reason} onChange={(e) => setReason(e.target.value)} sx={{ mt: 2 }} multiline minRows={2} />
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={danger ? 'error' : 'primary'}
          disabled={busy || (!!requireReason && reason.trim().length < 2)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm(reason.trim());
              setReason('');
              onClose();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <CircularProgress size={20} color="inherit" /> : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Banner shown on screens that require the central server. */
export function OnlineRequired({ online, children }: { online: boolean; children: ReactNode }) {
  if (online) return <>{children}</>;
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      This screen uses live data from the central server. Connect to the network and sign in again to use it. Everyday work (sales, receiving,
      transfers) continues offline.
    </Alert>
  );
}
