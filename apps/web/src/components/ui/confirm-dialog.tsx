import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button className={destructive ? 'bg-danger text-white hover:bg-danger/90' : undefined} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
