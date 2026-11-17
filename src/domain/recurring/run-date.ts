/**
 * What is not recorded yet about recurring invoice templates, kept in this one file
 * (spec/deviations.md D-111, D-112): what sevDesk generates on a run date (a draft or a finalized
 * invoice; sent or not), and whether a template at status 100 runs at all or only one at 200.
 * Templates of both statuses were left on the trial account on 2026-11-16 to find out; none had
 * generated anything by 00:58 on 2026-11-17. When the answer is recorded, these two constants are
 * what changes: the status a template is saved with, and the sentence every preview says about
 * the run date. The preview promises nothing in either direction until then.
 */
import { type Phrase, phrase } from "../preview-text.js";

/**
 * The status a new template is saved with: 100, the status sevDesk gives a new template
 * (recorded, D-112). 50 deactivates a template; 200 is accepted too and keeps the schedule.
 */
export const TEMPLATE_SAVE_STATUS = 100;

/** What sevDesk does on a run date, as the preview of every new template says it. */
export const RUN_DATE_BEHAVIOUR: Phrase = phrase(
  "Not recorded yet: what sevDesk generates on a run date (a draft, or a finalized invoice with a " +
    "number that is booked), whether it sends that invoice to the customer, and whether a " +
    `template saved with status ${String(TEMPLATE_SAVE_STATUS)} runs at all. Check the first ` +
    "invoice it generates in sevDesk.",
  "Noch nicht erfasst: was sevDesk an einem Ausführungstag erzeugt (einen Entwurf oder eine " +
    "fertiggestellte, gebuchte Rechnung mit Nummer), ob sevDesk diese Rechnung an den Kunden " +
    `versendet und ob eine mit Status ${String(TEMPLATE_SAVE_STATUS)} gespeicherte Vorlage ` +
    "überhaupt ausgeführt wird. Prüf die erste erzeugte Rechnung in sevDesk.",
);
