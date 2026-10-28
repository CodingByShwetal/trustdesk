import type { DB } from '../../db/client.js';
import { detectInjection, type InjectionHit } from '../guardrails/injection.js';
import { getPolicyFactsForTicket } from '../policy/service.js';

/** Everything a pipeline run needs about one ticket. Expected labels are never loaded. */
export async function loadTicketContext(db: DB, ticketId: string) {
  const { ticket, customer, order, facts } = await getPolicyFactsForTicket(db, ticketId);
  const flags: InjectionHit[] = detectInjection(`${ticket.subject}\n${ticket.body}`);
  return { ticket, customer, order, facts, flags, firstName: customer.name.split(/\s+/)[0] };
}

export type TicketContext = Awaited<ReturnType<typeof loadTicketContext>>;
