import { toast } from 'sonner';
import { http } from '@/api/http';

interface ConsoleTicket {
  role?: string;
  launch_url?: string | null;
  message?: string;
}

/**
 * Ask the API for a console ticket and open it in a new tab. The tab is reserved
 * synchronously so popup blockers do not swallow it after the network round trip.
 */
export async function openAssetConsole(drillId: number, assetId: number): Promise<void> {
  const popup = window.open('', '_blank', 'noopener,noreferrer');
  if (popup) {
    popup.document.title = 'Opening console';
    popup.document.body.textContent = 'Opening workstation console...';
  }
  try {
    const ticket = await http.post<ConsoleTicket>(`/api/v2/drills/${drillId}/access/${assetId}/console`, {});
    toast.success(`Console ticket ready${ticket.role ? ` for ${ticket.role}` : ''}`);
    if (ticket.launch_url) {
      if (popup && !popup.closed) popup.location.href = ticket.launch_url;
      else window.open(ticket.launch_url, '_blank', 'noopener,noreferrer');
    } else {
      if (popup && !popup.closed) popup.close();
      if (ticket.message) toast.info(ticket.message);
    }
  } catch (err) {
    if (popup && !popup.closed) popup.close();
    toast.error(`Failed to open console: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}
