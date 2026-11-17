/**
 * What sevDesk does with a recurring invoice template on a run date, kept in this one file
 * (spec/deviations.md D-111, D-112, D-132; recorded 2026-11-17 on the trial account, Update 2.0).
 *
 * Two switches of the template decide it, not its status. Three cases are recorded:
 * - automatic generation ("Automatische Generierung", `propertyAutoGenerateRecurringInvoice`) off,
 *   the default: sevDesk creates nothing (templates at status 100, "Aktiv" in the web app, and 200
 *   generated nothing in 36 hours);
 * - generation on, automatic sending ("Automatisches Versenden", `autoSendConfiguration`) off:
 *   within about a minute of a run time that has come, sevDesk creates a draft invoice (type RE,
 *   status 100), not finalized, not sent, with a provisional number. This is what this server
 *   sets;
 * - generation and sending on: about a minute later sevDesk also finalizes the invoice with its
 *   final number, e-mails it with the PDF and enshrines it. This server never switches sending on.
 *
 * The status a template is saved with and the sentences every preview says about the run date
 * live here, so a new finding changes this file only.
 */
import { type Phrase, phrase } from "../preview-text.js";

/**
 * The status a new template is saved with: 100, the status sevDesk gives a new template and the
 * one the web app's "Speichern und aktivieren" stores, shown there as "Aktiv" (recorded, D-112).
 * 50 deactivates a template; 200 is accepted too and keeps the schedule.
 */
export const TEMPLATE_SAVE_STATUS = 100;

/** The three recorded cases of the module comment. */
export type RunDateCase = "off" | "on" | "autoSending";

/**
 * What sevDesk does on a run date in each recorded case, as the preview of a new template says
 * it. The run time of a template made by this server is 00:00 Berlin time on the run date
 * (`accountStartDate` is sent as that moment).
 */
export const RUN_DATE_BEHAVIOUR: Readonly<Record<RunDateCase, Phrase>> = {
  off: phrase(
    "Automatic generation is off: sevDesk creates nothing from this template by itself, on no " +
      "run date, until someone switches automatic generation on for it in the sevDesk web app " +
      'or clicks "Rechnung erzeugen" there.',
    "Die automatische Generierung ist aus: sevDesk erzeugt aus dieser Vorlage von selbst nichts, " +
      "an keinem Ausführungstag, bis jemand sie in der sevDesk-Web-App für die Vorlage " +
      "einschaltet oder dort auf „Rechnung erzeugen“ klickt.",
  ),
  on: phrase(
    "Automatic generation is on: on every run date, within about a minute after 00:00 (Berlin " +
      "time), sevDesk creates a draft invoice from this template by itself, with these positions " +
      "and texts plus a line in the head text that names the billing period (the run date to " +
      "the day before the next run). sevDesk neither finalizes nor sends the draft, and its " +
      "number is provisional (several drafts can show the same number until each is " +
      "finalized): a person must still finalize and send every draft.",
    "Die automatische Generierung ist an: An jedem Ausführungstag erzeugt sevDesk etwa eine " +
      "Minute nach 0 Uhr (Berliner Zeit) selbst einen Rechnungsentwurf aus dieser Vorlage, mit " +
      "diesen Positionen und Texten und einer Zeile im Kopftext, die den Abrechnungszeitraum " +
      "nennt (vom Ausführungstag bis zum Tag vor der nächsten Ausführung). sevDesk stellt den " +
      "Entwurf weder fertig noch versendet ihn, und seine Nummer ist vorläufig (mehrere " +
      "Entwürfe können dieselbe Nummer zeigen, bis jeder fertiggestellt ist): Jeden Entwurf " +
      "muss noch jemand fertigstellen und versenden.",
  ),
  autoSending: phrase(
    "This server never switches on automatic sending (Automatisches Versenden). If someone " +
      "switches it on for the template in the sevDesk web app, sevDesk finalizes every invoice " +
      "it creates with its final number, e-mails it with the PDF to the customer and enshrines " +
      "it (festgeschrieben) within about two minutes of the run time, before anyone has seen it.",
    "Dieser Server schaltet das automatische Versenden nie ein. Schaltet es jemand in der " +
      "sevDesk-Web-App für die Vorlage ein, stellt sevDesk jede erzeugte Rechnung etwa zwei " +
      "Minuten nach der Ausführungszeit mit ihrer endgültigen Nummer fertig, schickt sie mit dem " +
      "PDF per E-Mail an den Kunden und schreibt sie fest, bevor jemand sie gesehen hat.",
  ),
};

/**
 * The `on` case for a stored template whose run time is not known to be 00:00: one made in the web
 * app stores its start and next run with the time of day it was saved at, and that time is then
 * the run time (recorded 2026-11-17, D-111). Same facts, without naming midnight.
 */
export const RUN_DATE_ON_AT_STORED_TIME: Phrase = phrase(
  "Automatic generation is on: on every run date, within about a minute of the run time stored " +
    "with the template's next run (not necessarily midnight), sevDesk creates a draft invoice " +
    "from this template by itself, with its positions and texts plus a line in the head text " +
    "that names the billing period. sevDesk neither finalizes nor sends the draft, and its " +
    "number is provisional: a person must still finalize and send every draft.",
  "Die automatische Generierung ist an: An jedem Ausführungstag erzeugt sevDesk etwa eine Minute " +
    "nach der Uhrzeit, die mit der nächsten Ausführung der Vorlage gespeichert ist (nicht " +
    "unbedingt Mitternacht), selbst einen Rechnungsentwurf aus dieser Vorlage, mit ihren " +
    "Positionen und Texten und einer Zeile im Kopftext, die den Abrechnungszeitraum nennt. " +
    "sevDesk stellt den Entwurf weder fertig noch versendet ihn, und seine Nummer ist vorläufig: " +
    "Jeden Entwurf muss noch jemand fertigstellen und versenden.",
);

/** Added when the first run is today and automatic generation is on: the run is due at once. */
export const FIRST_RUN_TODAY: Phrase = phrase(
  "The first run is today, so it is due at once: sevDesk creates the first draft within about a " +
    "minute of saving the template.",
  "Die erste Ausführung ist heute und damit sofort fällig: sevDesk erzeugt den ersten Entwurf " +
    "etwa eine Minute nach dem Speichern der Vorlage.",
);
