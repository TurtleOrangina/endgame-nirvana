<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  page: 'impressum' | 'datenschutz'
}>()

// Split so the address never appears as a plain string in the shipped bundle or DOM
// until a real visitor clicks to reveal it — keeps it off naive scraper wordlists.
const EMAIL_USER = 'endgame-nirvana'
const EMAIL_DOMAIN = 'proton.me'

const revealedEmail = ref<string | null>(null)

function revealEmail(): void {
  revealedEmail.value = `${EMAIL_USER}@${EMAIL_DOMAIN}`
}

function showPage(target: 'impressum' | 'datenschutz'): void {
  if (target === props.page) return
  history.pushState(null, '', `/${target}`)
  window.location.reload()
}
</script>

<template>
  <div class="legal-page">
    <div class="legal-header">
      <a class="back-link" href="/">&larr; Back to Endgame Nirvana</a>
      <nav class="legal-tabs">
        <button
          class="tab"
          :class="{ active: page === 'impressum' }"
          @click="showPage('impressum')"
        >
          Impressum
        </button>
        <button
          class="tab"
          :class="{ active: page === 'datenschutz' }"
          @click="showPage('datenschutz')"
        >
          Datenschutz
        </button>
      </nav>
    </div>

    <article v-if="page === 'impressum'" class="legal-content">
      <h1>Impressum</h1>
      <p class="legal-meta">Angaben gemäß § 5 E-Commerce-Gesetz (ECG)</p>

      <p>
        Endgame Nirvana ist ein privates, nicht-kommerzielles Hobbyprojekt ohne
        Gewinnerzielungsabsicht.
      </p>

      <h2>Betreiber</h2>
      <p>
        Peter Kirk<br />
        Österreich
      </p>

      <h2>Kontakt</h2>
      <p>
        <button v-if="!revealedEmail" class="reveal-btn" @click="revealEmail">
          E-Mail-Adresse anzeigen
        </button>
        <a v-else :href="`mailto:${revealedEmail}`">{{ revealedEmail }}</a>
      </p>
      <p class="legal-note">
        Da es sich um ein rein privates, unentgeltliches Projekt ohne kommerzielle Ausrichtung
        handelt, wird auf die Veröffentlichung einer postalischen Anschrift verzichtet. Rechtliche
        Anliegen und Zustellungen erreichen den Betreiber über die oben genannte E-Mail-Adresse.
      </p>

      <h2>Verantwortlich für den Inhalt</h2>
      <p>Peter Kirk (Anschrift wie oben)</p>

      <h2>Streitschlichtung</h2>
      <p>
        Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer"
          >ec.europa.eu/consumers/odr</a
        >. Der Betreiber ist mangels kommerzieller Tätigkeit weder verpflichtet noch bereit, an
        einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.
      </p>

      <h2>Urheberrecht &amp; Quellcode</h2>
      <p>
        Der Quellcode dieser Anwendung ist unter der
        <a
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noopener noreferrer"
          >GNU General Public License v3.0</a
        >
        veröffentlicht:
        <a
          href="https://github.com/TurtleOrangina/endgame-nirvana"
          target="_blank"
          rel="noopener noreferrer"
          >github.com/TurtleOrangina/endgame-nirvana</a
        >.
      </p>
    </article>

    <article v-else class="legal-content">
      <h1>Datenschutzerklärung</h1>

      <h2>1. Verantwortlicher</h2>
      <p>
        Peter Kirk, Österreich. Kontakt:
        <button v-if="!revealedEmail" class="reveal-btn" @click="revealEmail">
          E-Mail-Adresse anzeigen
        </button>
        <a v-else :href="`mailto:${revealedEmail}`">{{ revealedEmail }}</a>
      </p>

      <h2>2. Grundprinzip: lokal zuerst</h2>
      <p>
        Diese App funktioniert primär offline. Trainingsdaten (Ergebnisse, Elo, Einstellungen)
        werden standardmäßig ausschließlich lokal im Browser deines Geräts
        (<code>localStorage</code>) gespeichert und nicht an uns übertragen. Erst wenn du dich
        freiwillig für ein Konto registrierst, werden zusätzlich Daten an unseren
        Cloud-Backend-Anbieter übertragen, um deinen Fortschritt geräteübergreifend zu
        synchronisieren.
      </p>

      <h2>3. Welche Daten wir verarbeiten</h2>
      <p>
        <strong>Ohne Konto (lokale Nutzung):</strong> Nutzername, Elo-Wert, Trainingsverlauf und
        Einstellungen verbleiben ausschließlich auf deinem Gerät.
      </p>
      <p><strong>Mit Konto (freiwillige Registrierung):</strong></p>
      <ul>
        <li>
          E-Mail-Adresse und Passwort (das Passwort wird von unserem Auth-Anbieter gehasht
          gespeichert und ist uns nie im Klartext bekannt)
        </li>
        <li>Nutzername und Start-Elo</li>
        <li>
          Trainingsfortschritt: Elo-Verlauf sowie Anzahl gelöster/fehlgeschlagener Puzzles; einzelne
          Trainingsversuche mit Zeitstempel werden automatisch nach 8 Wochen gelöscht
        </li>
        <li>App-Einstellungen (z. B. Farbschema, Analyse-Präferenzen)</li>
      </ul>
      <p>
        <strong>Optional: Lichess-Kontoverknüpfung.</strong> Verknüpfst du dein Lichess-Konto (für
        Tablebase-Funktionen), speichern wir deinen öffentlichen Lichess-Benutzernamen in deinem
        Profil. Die Anmeldung selbst läuft über den offiziellen OAuth-Login von lichess.org; deine
        Lichess-Zugangsdaten gibst du ausschließlich dort ein, nie in dieser App.
      </p>

      <h2>4. Rechtsgrundlage</h2>
      <p>
        Die Verarbeitung erfolgt zur Erfüllung des von dir angeforderten Trainingskontos (Art. 6
        Abs. 1 lit. b DSGVO) bzw., soweit optionale Funktionen wie die Lichess-Verknüpfung betroffen
        sind, auf Grundlage deiner Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).
      </p>

      <h2>5. Empfänger / Auftragsverarbeiter</h2>
      <ul>
        <li>
          <strong>Supabase, Inc.</strong> – Hosting von Datenbank und Authentifizierung. Die
          Projektdaten werden in der Region <em>eu-west-2 (London, Vereinigtes Königreich)</em>
          gespeichert. Für das Vereinigte Königreich besteht ein Angemessenheitsbeschluss der
          Europäischen Kommission (Art. 45 DSGVO); zusätzliche Garantien wie
          Standardvertragsklauseln sind daher derzeit nicht erforderlich.
        </li>
        <li>
          <strong>Cloudflare, Inc.</strong> – Auslieferung dieser Website (Cloudflare
          Pages/Workers). Dabei werden technisch notwendige Verbindungsdaten (z. B. IP-Adresse)
          verarbeitet.
        </li>
        <li>
          <strong>Lichess.org</strong> – nur bei Nutzung der Tablebase-/Analysefunktion: die
          aktuelle Brettstellung (FEN) wird an <code>tablebase.lichess.ovh</code> übermittelt, wobei
          zwangsläufig deine IP-Adresse an Lichess übertragen wird. Der Schachmotor (Stockfish)
          läuft dagegen vollständig lokal in deinem Browser, ohne Datenübertragung.
        </li>
      </ul>

      <h2>6. Keine Analyse- oder Tracking-Tools</h2>
      <p>
        Diese App verwendet keine Analyse-, Tracking- oder Werbe-Cookies und keine
        Drittanbieter-Analysewerkzeuge. Es werden keine Cookies gesetzt; eine Sitzung wird
        ausschließlich über <code>localStorage</code> in deinem Browser verwaltet.
      </p>

      <h2>7. Speicherdauer</h2>
      <p>
        Kontodaten werden gespeichert, solange dein Konto besteht. Du kannst dein Konto und alle
        zugehörigen Daten jederzeit über den Profilbereich der App selbst löschen. Einzelne
        Trainingsversuche werden davon unabhängig automatisch nach 8 Wochen gelöscht.
      </p>

      <h2>8. Deine Rechte</h2>
      <p>
        Du hast nach der DSGVO das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung
        (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und
        Widerspruch (Art. 21). Wende dich dazu an die oben genannte Kontakt-E-Mail-Adresse. Du hast
        außerdem das Recht, dich bei der österreichischen Datenschutzbehörde zu beschweren:
        Österreichische Datenschutzbehörde, Barichgasse 40–42, 1030 Wien,
        <a href="https://www.dsb.gv.at" target="_blank" rel="noopener noreferrer">dsb.gv.at</a>.
      </p>

      <h2>9. Quellcode</h2>
      <p>
        Der Quellcode dieser Anwendung ist quelloffen unter der GNU GPL-3.0 verfügbar:
        <a
          href="https://github.com/TurtleOrangina/endgame-nirvana"
          target="_blank"
          rel="noopener noreferrer"
          >github.com/TurtleOrangina/endgame-nirvana</a
        >.
      </p>
    </article>
  </div>
</template>

<style scoped>
.legal-page {
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1.5rem 1rem 4rem;
}

.legal-header {
  width: 100%;
  max-width: 42rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.back-link {
  color: var(--muted);
  font-size: 0.875rem;
  text-decoration: none;
}

.back-link:hover {
  color: var(--accent);
}

.legal-tabs {
  display: flex;
  gap: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 0.5rem 0.9rem;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 0.9rem;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tab.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.legal-content {
  width: 100%;
  max-width: 42rem;
  line-height: 1.6;
  font-size: 0.95rem;
}

.legal-content h1 {
  font-size: 1.5rem;
  margin-bottom: 0.25rem;
}

.legal-content h2 {
  font-size: 1.05rem;
  margin-top: 1.75rem;
  margin-bottom: 0.5rem;
}

.legal-meta {
  color: var(--muted);
  font-size: 0.85rem;
  margin-bottom: 1.5rem;
}

.legal-note {
  color: var(--muted);
  font-size: 0.875rem;
}

.legal-content a {
  color: var(--accent);
}

.legal-content ul {
  padding-left: 1.25rem;
}

.legal-content li {
  margin-bottom: 0.4rem;
}

.legal-content code {
  background: var(--badge-bg);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  font-size: 0.85em;
}

.reveal-btn {
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.875rem;
  cursor: pointer;
}

.reveal-btn:hover {
  border-color: var(--accent);
}
</style>
