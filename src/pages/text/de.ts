/**
 * The German texts of the server's own pages. Same shape as the English ones (`en.ts`); the voice
 * follows the website: formal "Sie", "Freigabe" for an approval, "Freigabe-Postfach" for the
 * inbox, "das Token".
 */
import { type Html, markup } from "../html.js";
import { message, type Texts } from "./en.js";

const APPROVED = message(
  "Freigegeben",
  "Sie haben diese Aktion freigegeben. Kehren Sie zu Ihrem Assistenten zurück: Er führt die " +
    "Aktion aus, sobald er das Tool mit denselben Argumenten erneut aufruft, bevor die Anfrage " +
    "abläuft.",
);
const REJECTED = message(
  "Abgelehnt",
  "Sie haben diese Aktion abgelehnt. In sevDesk wurde nichts geändert.",
);
const APPROVAL_NOT_FOUND = message(
  "Freigabe nicht gefunden",
  "Diese Freigabe-Anfrage ist unbekannt, abgelaufen oder wurde bereits verwendet. Bitten Sie " +
    "Ihren Assistenten, es erneut zu versuchen, wenn Sie die Aktion weiterhin wünschen.",
);

export const de: Texts = {
  frame: {
    disclaimer:
      "Inoffizielles Community-Projekt. Nicht mit der sevdesk GmbH verbunden, nicht von ihr " +
      "unterstützt oder empfohlen.",
  },

  approval: {
    title: "sevDesk-Aktion freigeben",
    eyebrow: "sevDesk MCP bittet um Ihre Freigabe",
    heading: "Diese Aktion freigeben?",
    lead:
      "Ihr KI-Assistent möchte diese Änderung in sevDesk vornehmen. Lesen Sie alles durch und " +
      "entscheiden Sie dann.",
    tier: {
      write: "Ändert umkehrbare Datensätze",
      commit: "Rechtlich bindende Buchhaltung",
      external: "Erreicht Personen außerhalb von sevDesk",
    },
    irreversible: "Das lässt sich nicht rückgängig machen.",
    changed:
      "Der Datensatz hat sich geändert, nachdem Sie gefragt wurden; dies ist deshalb eine neue " +
      "Anfrage. Prüfen Sie die Angaben erneut.",
    unless: "Ohne Ihre Freigabe passiert nichts.",
    approve: "Freigeben",
    reject: "Ablehnen",
    reference: "Referenz",
    tool: (name: Html) => markup`Tool ${name}`,
    sameCode: "Ihr Assistent nennt denselben Referenzcode.",
    expiresIn: "Läuft ab in",
    validUntil: (time: Html) => markup`Gültig bis ${time}.`,
    once: "Die Anfrage kann einmal entschieden werden.",
    next:
      "Kehren Sie nach der Freigabe zu Ihrem Assistenten zurück: Er führt die Aktion aus, sobald " +
      "er das Tool erneut aufruft.",
    expired: "Diese Anfrage ist abgelaufen. Bitten Sie Ihren Assistenten, es erneut zu versuchen.",
    decided: { action: "Aktion" },
  },

  inboxPage: {
    title: "sevDesk-Freigaben",
    heading: "sevDesk\u2011Freigaben",
    lead: (account: Html) =>
      markup`Angemeldet für das sevDesk-Konto ${account}. Öffnen Sie eine Anfrage, um genau zu sehen, was sie bewirkt, und geben Sie sie dann frei oder lehnen Sie sie ab.`,
    waiting: (count: number) =>
      count === 0 ? "Nichts wartet" : count === 1 ? "1 wartet" : `${String(count)} warten`,
    refresh: "Aktualisieren",
    signOut: "Abmelden",
    review: "Prüfen",
    tool: (name: Html) => markup`Tool ${name}`,
    status: {
      pending: "Wartet auf Ihre Entscheidung",
      approved: "Freigegeben",
      rejected: "Abgelehnt",
    },
    expires: (time: Html) => markup`läuft ab ${time}`,
    runnableUntil: (time: Html) => markup`Ihr Assistent kann sie bis ${time} ausführen`,
    emptyTitle: "Nichts wartet auf Sie",
    empty:
      "Im Moment gibt es keine Freigabe-Anfragen. Wenn Ihr Assistent eine stellt, laden Sie " +
      "diese Seite neu.",
    fine:
      "Anfragen laufen nach wenigen Minuten ab und können einmal entschieden werden. Kehren Sie " +
      "nach der Freigabe zu Ihrem Assistenten zurück: Er führt die Aktion aus, sobald er das " +
      "Tool erneut aufruft.",
  },

  signIn: {
    approvals: {
      title: "Anmelden: sevDesk-Freigaben",
      heading: "Anmelden, um sevDesk\u2011Aktionen freizugeben",
      lead:
        "Um Freigabe-Anfragen Ihres KI-Assistenten zu sehen und zu entscheiden, melden Sie sich " +
        "mit dem API-Token des sevDesk-Kontos an.",
    },
    files: {
      title: "Anmelden: sevDesk-Dateien",
      heading: "Anmelden, um Dateien zu übertragen",
      lead:
        "Um Dateien für Ihren KI-Assistenten hoch- oder herunterzuladen, melden Sie sich mit dem " +
        "API-Token des sevDesk-Kontos an.",
    },
    onlyOn: (host: Html) =>
      markup`Geben Sie Ihr Token nur auf ${host} ein. Prüfen Sie zuerst die Adressleiste: Überall sonst ist eine Seite, die danach fragt, Phishing.`,
    tokenLabel: "sevDesk-API-Token",
    where: "In sevDesk: Einstellungen → Benutzer → API-Token.",
    submit: "Anmelden",
    fine: (hours: number) =>
      `Das Token wird einmal geprüft und nicht gespeichert. Die Anmeldung gilt ${String(hours)} ` +
      "Stunden in diesem Browser oder bis Sie sich abmelden.",
  },

  tiers: {
    read: { label: "Lesen", text: "liest nur; ändert nichts in sevDesk" },
    write: {
      label: "Entwerfen",
      text: "erstellt oder ändert umkehrbare Datensätze (Kontakte, Artikel, Entwürfe)",
    },
    commit: {
      label: "Buchen",
      text:
        "rechtlich bindende oder schwer umkehrbare Buchhaltung (festschreiben, Zahlungen " +
        "buchen, stornieren); fragt vorher einen Menschen",
    },
    external: {
      label: "Versenden",
      text:
        "erreicht Dritte, z. B. sendet ein Dokument per E-Mail an Kunden; fragt vorher einen " +
        "Menschen",
    },
  },

  tiersUnconfirmed: {
    commit: {
      label: "Buchen",
      text:
        "rechtlich bindende oder schwer umkehrbare Buchhaltung (festschreiben, Zahlungen " +
        "buchen, stornieren); auf diesem Server ohne Rückfrage",
    },
    external: {
      label: "Versenden",
      text:
        "erreicht Dritte, z. B. sendet ein Dokument per E-Mail an Kunden; auf diesem Server " +
        "ohne Rückfrage",
    },
  },

  connect: {
    title: "Mit sevDesk verbinden",
    heading: "Eine App mit sevDesk verbinden",
    steps: { token: "Berechtigungen und Token", confirm: "Konto bestätigen" },
    wants: (host: Html) =>
      markup`Die App unter ${host} möchte über diesen Server Ihr sevDesk-Konto verwenden.`,
    selfDeclared: (name: string) => `Sie nennt sich „${name}“ (eigene Angabe, nicht überprüft).`,
    returns: (host: Html) => markup`Nach dem Verbinden kehrt Ihr Browser zu ${host} zurück.`,
    loopback: (host: Html) =>
      markup`Diese App läuft auf Ihrem eigenen Computer: Nach dem Verbinden kehrt Ihr Browser zu ${host} zurück. Fahren Sie nur fort, wenn Sie das Verbinden gerade selbst in einer App auf diesem Gerät gestartet haben.`,
    legend: "Was darf sie tun?",
    tiersHint: "Buchen und Versenden fragen Sie weiterhin bei jeder einzelnen Aktion.",
    tiersHintUnconfirmed:
      "Dieser Server führt Buchen und Versenden ohne jede Rückfrage aus: Was die App in diesen " +
      "Stufen tut, wirkt sofort. Erteilen Sie sie nur, wenn Sie der App voll vertrauen.",
    tokenLabel: "Ihr sevDesk-API-Token",
    tokenHint:
      "In sevDesk: Einstellungen → Benutzer → API-Token. Es wird in diese Verbindung " +
      "verschlüsselt und auf dem Server nicht lesbar gespeichert. Wer Zugriff auf die App hat, " +
      "kann sevDesk im Rahmen der hier gewählten Stufen nutzen, bis Sie die Verbindung trennen.",
    check: "Token prüfen",
    cancel: "Abbrechen",
    // U+2011 (a hyphen that does not break): the heading must not wrap inside "sevDesk-Konto".
    confirmHeading: (accountId: string) => `Mit dem sevDesk\u2011Konto ${accountId} verbinden?`,
    account: "sevDesk-Konto",
    accountName: "Name laut sevDesk",
    quoted: (name: string) => `„${name}“`,
    mayLabel: "Die App darf",
    submit: "Verbinden",
    fine: (command: Html) =>
      markup`Sie können die Verbindung jederzeit in der App trennen; der Betreiber des Servers kann sie mit ${command} widerrufen.`,
  },

  upload: {
    batch: {
      title: "Dateien hochladen",
      lead: (count: number, account: Html) =>
        markup`Ihr KI-Assistent hat ${String(count)} Dateien für das sevDesk-Konto ${account} angefordert. Nur die Verbindung, die danach gefragt hat, kann sie verwenden. Hier wird nichts an sevDesk gesendet.`,
      remaining: (count: number) =>
        count === 1 ? "1 freier Platz für eine Datei" : `${String(count)} freie Plätze für Dateien`,
      total: "Verfügbarer Speicher für diesen Upload",
      tooLarge: (limit: string) =>
        message(
          "Auswahl zu groß",
          `Die ausgewählten Dateien überschreiten zusammen den verfügbaren Speicher für diesen Upload (${limit}). Wählen Sie weniger Dateien aus. Bereits hochgeladene Dateien bleiben verfügbar.`,
        ),
      files: "Dateien",
      hint: "Wählen Sie mehrere Dateien aus oder ziehen Sie sie auf das Feld. Laden Sie nur Dateien hoch, die in der Liste unten noch fehlen.",
      progress: "Dateien dieser Anfrage",
      slot: (number: number) => `Datei ${String(number)}`,
      pending: "Wartet auf eine Datei",
      receiving: "Wird empfangen",
      uploaded: "Hochgeladen",
      expired: "Abgelaufen",
      used: "Bereits angehängt",
      fine: "Sagen Sie Ihrem Assistenten Bescheid, wenn Sie fertig sind. Er kann die hochgeladenen Dateien anhand ihrer Namen zuordnen. Nur Dateien mit dem Status „Hochgeladen“ sind verfügbar. Wählen Sie nach einem fehlgeschlagenen Upload die fehlenden Dateien erneut aus. Bei gleichen Namen kann eine Rückfrage nötig sein.",
      closed:
        "Auf dieser Seite sind keine Plätze mehr frei. Dateien mit dem Status „Hochgeladen“ bleiben bis zu ihrem jeweiligen Ablauf verfügbar.",
      badForm: message(
        "Ungültige Auswahl",
        "Wählen Sie über dieses Formular mindestens eine Datei und höchstens so viele wie freie Plätze aus.",
      ),
      staleForm: message(
        "Dateiliste geändert",
        "Dieses Formular ist veraltet. Aus diesem Upload wurden keine Dateien gespeichert. Prüfen Sie die Liste unten und wählen Sie über dieses Formular nur die noch fehlenden Dateien aus.",
      ),
    },
    receipt: { title: "Beleg hochladen", noun: "einen Beleg" },
    einvoice: {
      title: "E-Rechnung hochladen",
      noun: "eine E-Rechnung (XRechnung oder ZUGFeRD)",
    },
    lead: (noun: string, account: Html) =>
      markup`Ihr KI-Assistent hat um ${noun} für das sevDesk-Konto ${account} gebeten. Wählen Sie die Datei hier aus: Sie geht nur an diesen Server, und nur die Assistenten-Verbindung, die danach gefragt hat, kann sie verwenden.`,
    accepted: "Akzeptiert",
    byContent: (kinds: string) => `${kinds} (am Inhalt geprüft)`,
    or: "oder",
    largest: "Größte Datei",
    useBefore: "Verwendbar bis",
    file: "Datei",
    dropHint: "Wählen Sie eine Datei aus oder ziehen Sie sie auf das Feld.",
    submit: "Hochladen",
    fine:
      "Diese Seite nimmt eine Datei an. Kehren Sie nach dem Hochladen zu Ihrem Assistenten " +
      "zurück und sagen Sie ihm, dass die Datei da ist.",
    received: "Datei empfangen",
    receivedLead: (name: Html, kind: string, size: string, time: Html) =>
      markup`Der Server hat ${name} empfangen (${kind}, ${size}). Kehren Sie zu Ihrem Assistenten zurück und sagen Sie ihm, dass der Upload abgeschlossen ist. Er kann die Datei bis ${time} verwenden.`,
  },

  inbox: {
    approved: APPROVED,
    rejected: REJECTED,
    notFound: APPROVAL_NOT_FOUND,
    expired: message(
      "Freigabe abgelaufen",
      "Diese Freigabe-Anfrage ist nicht mehr gültig. Bitten Sie Ihren Assistenten, es erneut zu " +
        "versuchen.",
    ),
    foreignPost: message(
      "Anfrage abgelehnt",
      "Die Anfrage kam nicht von einer Seite dieses Servers.",
    ),
    csrf: message(
      "Anfrage abgelehnt",
      "Die Anfrage konnte nicht überprüft werden. Laden Sie die Seite neu und versuchen Sie es " +
        "erneut.",
    ),
    signedOutPost: message(
      "Erneut anmelden",
      "Ihre Anmeldung ist beendet. Öffnen Sie das Freigabe-Postfach, melden Sie sich erneut an " +
        "und wiederholen Sie Ihre Entscheidung.",
    ),
    noDecision: message("Ungültige Anfrage", "Wählen Sie „Freigeben“ oder „Ablehnen“."),
    badForm: message("Ungültige Anfrage", "Das Formular konnte nicht gelesen werden."),
    method: message(
      "Methode nicht erlaubt",
      "Verwenden Sie die Schaltflächen auf den Seiten des Freigabe-Postfachs.",
    ),
    tooLarge: message(
      "Anfrage zu groß",
      "Das Formular ist größer als das, was diese Seite sendet.",
    ),
    signedOut: message(
      "Abgemeldet",
      "Sie sind in diesem Browser vom Freigabe-Postfach abgemeldet.",
    ),
    notReady: message(
      "Postfach noch nicht bereit",
      "Das Freigabe-Postfach startet gerade. Versuchen Sie es gleich noch einmal.",
    ),
    back: "Zurück zum Freigabe-Postfach",
  },

  session: {
    signedIn: message(
      "Angemeldet",
      "Sie sind in diesem Browser bei diesem Server angemeldet. Öffnen Sie den Link, den Ihr " +
        "Assistent Ihnen gegeben hat, noch einmal.",
    ),
    signedOut: message("Abgemeldet", "Sie sind in diesem Browser von diesem Server abgemeldet."),
  },

  login: {
    empty: "Fügen Sie das API-Token Ihres sevDesk-Kontos genau so ein, wie sevDesk es anzeigt.",
    refused: "Das Token wurde nicht akzeptiert.",
    notAllowed: "Dieser Server ist nicht für das sevDesk-Konto dieses Tokens eingerichtet.",
    wrongToken: "Dies ist nicht das sevDesk-API-Token, mit dem dieser Server eingerichtet ist.",
    rejected: "sevDesk hat dieses API-Token nicht akzeptiert.",
    unavailable:
      "Das Token konnte gerade nicht geprüft werden. Versuchen Sie es gleich noch einmal.",
    limited:
      "Zu viele Anmeldeversuche aus diesem Netzwerk. Warten Sie eine Minute und versuchen Sie " +
      "es dann erneut.",
  },

  local: {
    approved: APPROVED,
    rejected: REJECTED,
    notFound: APPROVAL_NOT_FOUND,
    expired: message("Freigabe abgelaufen", "Diese Freigabe-Anfrage ist nicht mehr gültig."),
    wrongAddress: message(
      "Falsche Adresse",
      "Öffnen Sie den Freigabe-Link genau so, wie er angegeben wurde.",
    ),
    noPage: message("Nicht gefunden", "Unter dieser Adresse gibt es keine Seite."),
    method: message(
      "Methode nicht erlaubt",
      "Verwenden Sie die Schaltflächen auf der Freigabeseite.",
    ),
    foreignPost: message("Anfrage abgelehnt", "Die Entscheidung kam nicht von der Freigabeseite."),
    csrf: message(
      "Anfrage abgelehnt",
      "Die Entscheidung konnte nicht überprüft werden. Laden Sie die Freigabeseite neu und " +
        "versuchen Sie es erneut.",
    ),
    noDecision: message("Ungültige Anfrage", "Wählen Sie „Freigeben“ oder „Ablehnen“."),
    badForm: message("Ungültige Anfrage", "Das Formular konnte nicht gelesen werden."),
    needLink: message(
      "Freigabe-Link öffnen",
      "Diese Seite öffnet sich nur über den Freigabe-Link, den der Server in sein Protokoll " +
        "geschrieben oder für Sie geöffnet hat, und nur in dem Browser, der ihn geöffnet hat. " +
        "Die Adresse allein zeigt die Anfrage nicht.",
    ),
    linkUsed: message(
      "Link bereits verwendet",
      "Dieser Freigabe-Link wurde ein zweites Mal geöffnet, von einem anderen Browser oder " +
        "Programm. Ein Link funktioniert nur einmal. Deshalb wurde die Anfrage abgebrochen, in " +
        "sevDesk wurde nichts geändert. Bitten Sie Ihren Assistenten, es erneut zu versuchen: " +
        "Sie erhalten dann einen neuen Link.",
    ),
    linkUsedDecided: message(
      "Link bereits verwendet",
      "Dieser Freigabe-Link wurde schon einmal geöffnet, von einem anderen Browser oder " +
        "Programm, und die Anfrage wurde dort entschieden. Ein Link funktioniert nur einmal. " +
        "Waren das nicht Sie, stoppen Sie Ihren Assistenten und prüfen Sie, wer diesen " +
        "Computer noch nutzt.",
    ),
  },

  transfer: {
    uploadNotFound: message(
      "Upload-Seite nicht gefunden",
      "Diese Upload-Seite ist unbekannt, abgelaufen oder gehört zu einem anderen sevDesk-Konto. " +
        "Bitten Sie Ihren Assistenten um einen neuen Upload-Link.",
    ),
    uploadExpired: message(
      "Upload-Seite abgelaufen",
      "Diese Upload-Seite ist nicht mehr gültig. Bitten Sie Ihren Assistenten um einen neuen " +
        "Upload-Link.",
    ),
    alreadyUploaded: message(
      "Bereits hochgeladen",
      "Auf dieser Seite wurde bereits eine Datei hochgeladen. Um eine weitere Datei zu senden, " +
        "bitten Sie Ihren Assistenten um einen neuen Upload-Link.",
    ),
    receiving: message(
      "Upload läuft",
      "Für diese Seite wird gerade eine Datei empfangen. Laden Sie die Seite gleich neu.",
    ),
    wrongKind: message(
      "Dateityp nicht akzeptiert",
      "Diese Seite nimmt diesen Dateityp nicht an. Der Typ wird am Inhalt der Datei geprüft, " +
        "nicht an ihrem Namen. Gehen Sie zurück und wählen Sie eine andere Datei.",
    ),
    empty: message(
      "Leere Datei",
      "Die gewählte Datei ist leer. Gehen Sie zurück und wählen Sie eine andere.",
    ),
    badForm: message(
      "Ungültige Anfrage",
      "Der Upload konnte nicht gelesen werden. Senden Sie eine Datei über das Formular auf der " +
        "Upload-Seite.",
    ),
    lengthRequired: message(
      "Größe fehlt",
      "Der Upload hat seine Größe nicht angegeben. Verwenden Sie das Formular auf der " +
        "Upload-Seite in einem aktuellen Browser.",
    ),
    tooLarge: (limit: string) =>
      message(
        "Datei zu groß",
        `Die Datei ist größer, als diese Seite annimmt (${limit}). Gehen Sie zurück und wählen ` +
          "Sie eine kleinere Datei.",
      ),
    foreignPost: message(
      "Anfrage abgelehnt",
      "Der Upload kam nicht von einer Seite dieses Servers. Öffnen Sie den Upload-Link erneut.",
    ),
    csrf: message(
      "Anfrage abgelehnt",
      "Der Upload konnte nicht überprüft werden. Laden Sie die Upload-Seite neu und versuchen " +
        "Sie es erneut.",
    ),
    signedOut: message(
      "Erneut anmelden",
      "Ihre Anmeldung ist beendet. Öffnen Sie den Upload-Link erneut, melden Sie sich an und " +
        "wählen Sie die Datei noch einmal.",
    ),
    limited: message(
      "Zu viele Uploads",
      "Zu viele Uploads aus diesem Netzwerk. Warten Sie eine Minute und versuchen Sie es dann " +
        "erneut.",
    ),
    busy: message(
      "Server ausgelastet",
      "Gerade werden andere Uploads empfangen. Versuchen Sie es gleich noch einmal.",
    ),
    busyAccount: message(
      "Upload läuft",
      "Gerade wird ein anderer Upload dieses sevDesk-Kontos empfangen. Warten Sie, bis er " +
        "abgeschlossen ist, und versuchen Sie es dann erneut.",
    ),
    storageFull: message(
      "Kein Platz für die Datei",
      "Der Server hat gerade keinen Platz für diese Datei: Dieses sevDesk-Konto oder alle Konten " +
        "zusammen halten zu viele Dateien. Versuchen Sie es erneut, sobald ältere Uploads und " +
        "Download-Links abgelaufen sind.",
    ),
    failed: message(
      "Upload fehlgeschlagen",
      "Die Datei konnte nicht gespeichert werden. Versuchen Sie es gleich noch einmal.",
    ),
    fileNotFound: message(
      "Datei nicht gefunden",
      "Dieser Download-Link ist unbekannt, abgelaufen oder gehört zu einem anderen " +
        "sevDesk-Konto. Bitten Sie Ihren Assistenten, die Datei erneut zu erstellen.",
    ),
    fileExpired: message(
      "Download-Link abgelaufen",
      "Dieser Download-Link ist nicht mehr gültig. Bitten Sie Ihren Assistenten, die Datei " +
        "erneut zu erstellen.",
    ),
    fileExhausted: message(
      "Download-Link aufgebraucht",
      "Dieser Download-Link wurde bereits so oft verwendet, wie er es erlaubt. Bitten Sie Ihren " +
        "Assistenten, die Datei erneut zu erstellen.",
    ),
  },

  consent: {
    errors: {
      incompleteLink: message(
        "Dieser Anmelde-Link ist unvollständig",
        "Die Anfrage nennt keinen eindeutigen Client (client_id). Starten Sie das Verbinden " +
          "erneut in Ihrer App.",
      ),
      appNotAllowed: (host: string) =>
        message(
          "Diese App ist nicht erlaubt",
          `Dieser Server akzeptiert die App unter ${host} nicht. Der Betreiber kann sie in ` +
            "SEVDESK_OAUTH_CLIENTS erlauben.",
        ),
      unknownApp: message(
        "Unbekannte App",
        "Die client_id ist nicht die https-Adresse eines Client-Metadaten-Dokuments.",
      ),
      unverified: (detail: string) =>
        message(
          "Die App konnte nicht überprüft werden",
          "Das Metadaten-Dokument der App wurde nicht akzeptiert. Technischer Hinweis des " +
            `Servers (englisch): ${detail}`,
        ),
      unknownRedirect: (host: string) =>
        message(
          "Unbekannte Weiterleitungsadresse",
          `Die Weiterleitungsadresse fehlt oder ist von der App unter ${host} nicht ` +
            "registriert; deshalb leitet dieser Server Sie nicht dorthin weiter. Starten Sie das " +
            "Verbinden erneut in Ihrer App.",
        ),
      accountNotAllowed: (accountId: string) =>
        message(
          "Dieses sevDesk-Konto ist nicht erlaubt",
          `Dieser Server akzeptiert das sevDesk-Konto ${accountId} nicht. Der Betreiber kann es ` +
            `erlauben, indem er ${accountId} zu SEVDESK_OAUTH_ACCOUNTS hinzufügt.`,
        ),
      checkFirst: message(
        "Prüfen Sie zuerst das Token",
        "Starten Sie das Verbinden erneut in Ihrer App.",
      ),
      alreadyUsed: message(
        "Diese Seite wurde bereits verwendet",
        "Jede Zustimmungsseite verbindet genau einmal. Starten Sie das Verbinden erneut in " +
          "Ihrer App.",
      ),
      tooManyConnections: (limit: number) =>
        message(
          "Zu viele Verbindungen",
          `Dieser Server hält bereits ${String(limit)} Verbindungen. Der Betreiber kann ` +
            "ungenutzte mit `mcp-server-sevdesk grants revoke` widerrufen; versuchen Sie es " +
            "danach erneut.",
        ),
      foreignPost: message(
        "Anfrage abgelehnt",
        "Dieses Formular kann nur von seiner eigenen Seite gesendet werden.",
      ),
      formUnreadable: (reason: string) =>
        message("Anfrage abgelehnt", `Das Formular konnte nicht gelesen werden (${reason}).`),
      expired: message(
        "Diese Seite ist abgelaufen",
        "Zustimmungsseiten sind 10 Minuten gültig. Starten Sie das Verbinden erneut in Ihrer App.",
      ),
      csrf: message(
        "Anfrage abgelehnt",
        "Dieses Formular wurde nicht von der Seite gesendet, die dieser Browser geöffnet hat. " +
          "Starten Sie das Verbinden erneut in Ihrer App (Cookies müssen für diese Website " +
          "erlaubt sein).",
      ),
      unknownStep: message("Anfrage abgelehnt", "Unbekannter Schritt."),
      unavailable: message(
        "Vorübergehend nicht verfügbar",
        "Der Server startet neu. Versuchen Sie es in einer Minute erneut.",
      ),
    },
    check: {
      badToken:
        "Das ist kein sevDesk-API-Token: Kopieren Sie die 32 Zeichen (Ziffern und die Buchstaben " +
        "a bis f) aus sevDesk, Einstellungen → Benutzer → API-Token.",
      limited: "Zu viele Versuche. Warten Sie eine Minute und versuchen Sie es dann erneut.",
      unauthorized:
        "sevDesk hat dieses Token nicht akzeptiert. Kopieren Sie es erneut aus sevDesk " +
        "(Einstellungen → Benutzer → API-Token); ein neu erzeugtes Token ersetzt das alte.",
      noAnswer:
        "Das Token konnte nicht geprüft werden, weil sevDesk nicht wie erwartet geantwortet " +
        "hat. Versuchen Sie es gleich noch einmal.",
      badAccount:
        "sevDesk hat eine unerwartete Konto-ID zurückgegeben. Versuchen Sie es gleich noch " +
        "einmal.",
    },
  },
};
