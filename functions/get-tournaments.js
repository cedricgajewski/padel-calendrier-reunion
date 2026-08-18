// netlify/functions/get-tournaments.js
//
// Fonction serverless : va chercher la page padelmagazine (ligue Réunion),
// en extrait les tournois, et renvoie du JSON propre.
//
// IMPORTANT — best effort :
// Cette fonction n'a jamais été testée contre le HTML brut réel de
// padelmagazine (seule une version convertie en texte était disponible
// au moment de l'écriture). L'extraction se fait donc par aplatissement
// du HTML en texte + reconnaissance de motifs (dates, catégories P25-P2000,
// noms de club, emails), plutôt que par sélecteurs CSS précis.
//
// Si padelmagazine change la structure de sa page, ou si le format ne
// matche plus, la fonction renvoie `ok: false` et le front-end doit
// retomber sur les données statiques (voir index.html).

const SOURCE_URL = "https://tournois.padelmagazine.fr/ligues/reunion";

const MONTHS = {
  "janv": "01", "janvier": "01",
  "févr": "02", "fevr": "02", "février": "02", "fevrier": "02",
  "mars": "03",
  "avr": "04", "avril": "04",
  "mai": "05",
  "juin": "06",
  "juil": "07", "juillet": "07",
  "août": "08", "aout": "08",
  "sept": "09", "septembre": "09",
  "oct": "10", "octobre": "10",
  "nov": "11", "novembre": "11",
  "déc": "12", "dec": "12", "décembre": "12", "decembre": "12"
};

// Liste des clubs connus — fusion de deux sources :
// 1) Les clubs déjà vus dans les données de tournois FFT/padelmagazine
//    (méthode principale, prouvée en production)
// 2) L'annuaire complet des clubs de padel de La Réunion (AssoPei), pour
//    ne pas dépendre uniquement de ce qui avait déjà été observé — un club
//    présent ici mais qui n'a jamais publié de tournoi homologué ne posera
//    aucun problème, il ne sera simplement jamais matché (ce qui est normal).
const KNOWN_CLUBS = [
  // Nord
  "HANGAR",
  "TCM CHAMP-FLEURI", "TENNIS ET PADEL CLUB DE SAINT DENIS", "TENNIS ET PADEL CLUB DE SAINT-DENIS",
  "SMASH PADEL",
  // Ouest
  "REUNION PADEL CLUB",
  "TENNIS CLUB DE L OASIS", "TENNIS CLUB DE L'OASIS", "OASIS PADEL TENNIS CLUB",
  "KAZ A PADEL CLUB", "KAZ A PADEL", "KAZ À PADEL",
  "COCO PADEL",
  // Sud
  "PADEL-TENNIS REUNION 4 PADEL", "4PADEL REUNION", "4PADEL RÉUNION",
  "ENDEMIK CLUB", "ENDEMIK PADEL CLUB",
  "PADEL PARADISE", "PADEL PARADISE REUNION", "PADEL PARADISE RÉUNION",
  // Est
  "BOCAGE PADEL CLUB", "BOCAGE",
  // Autres clubs vus sur les données FFT, hors annuaire initial
  "T.C. DIONYSIEN STE CLOTILDE", "USPG SECTION TENNIS", "U.S.P.G.SECTION TENNIS"
];

function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Les icônes (téléphone, adresse, club, arbitre...) portent souvent
    // leur label dans l'attribut alt — on le réinjecte comme texte avant
    // de retirer les balises, sinon ce label serait perdu silencieusement.
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "\n$1\n")
    .replace(/<(h1|h2|h3|h4|h5|h6|p|div|li|br|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&eacute;|&#233;/g, "é")
    .replace(/&egrave;|&#232;/g, "è")
    .replace(/&agrave;|&#224;/g, "à")
    .replace(/&ccedil;|&#231;/g, "ç")
    .replace(/&ocirc;|&#244;/g, "ô")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Matches things like "18 août 2026" or "18 août 2026 - 20 août 2026"
const DATE_RE = /(\d{1,2})\s+([a-zéû.]+)\.?\s+(\d{4})/gi;
// Matches "P25", "P50", "P100" ... "P2000" possibly followed by a label
const TIER_RE = /\bP(25|50|100|250|500|1000|1500|2000)\b[^\n]{0,60}/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// Repli générique : la page source affiche souvent un label "Club" (texte
// ou alt d'icône) juste avant le nom — utile pour capter un club absent
// de KNOWN_CLUBS sans avoir à mettre ce fichier à jour manuellement.
const CLUB_LABEL_RE = /^club\s*:?\s*$/i;
// Mots qui sont des labels de la page (titres de section, alt d'icônes)
// et jamais des noms de club — à exclure explicitement.
const LABEL_WORDS = new Set([
  "club", "arbitre", "tournoi", "adresse", "contact", "email", "mail",
  "telephone", "téléphone", "horaires", "informations", "inscription",
  "date", "categorie", "catégorie"
]);
function looksLikeClubName(line) {
  if (!line || line.length > 80) return false;
  if (EMAIL_RE.test(line)) return false;
  if (/^\d/.test(line)) return false; // commence par un chiffre → probablement adresse/téléphone
  const normalized = line.trim().toLowerCase().replace(/:$/, "");
  if (LABEL_WORDS.has(normalized)) return false;
  return true;
}

function parseTournaments(rawHtml) {
  const text = stripToText(rawHtml);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const results = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dateMatch = [...line.matchAll(DATE_RE)];

    if (dateMatch.length > 0) {
      // Flush previous entry
      if (current && current.tier) results.push(current);
      current = { dateLabel: line, tier: null, name: null, club: null, contact: null };
      continue;
    }

    if (!current) continue;

    if (!current.tier && TIER_RE.test(line)) {
      current.tier = "P" + line.match(TIER_RE)[1];
      current.name = line.trim();
      continue;
    }

    if (!current.club) {
      // 1) Méthode principale (prouvée) : correspondance dans la liste connue
      const found = KNOWN_CLUBS.find(c => line.toUpperCase().includes(c));
      if (found) { current.club = found; continue; }

      // 2) Repli générique : ancrage "Club" → ligne suivante = nom du club
      if (CLUB_LABEL_RE.test(line)) {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          if (looksLikeClubName(lines[j])) {
            current.club = lines[j].toUpperCase();
            i = j;
            break;
          }
        }
        continue;
      }
    }

    if (!current.contact && EMAIL_RE.test(line)) {
      current.contact = line.match(EMAIL_RE)[0];
    }
  }
  if (current && current.tier) results.push(current);

  return results.filter(t => t.tier && t.dateLabel);
}

export async function handler() {
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PadelReunionCalendarBot/1.0)" }
    });

    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: `Upstream returned ${res.status}` })
      };
    }

    const html = await res.text();
    const tournaments = parseTournaments(html);

    if (tournaments.length === 0) {
      // Parsing failed to find anything — signal the front-end to fall back
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
        body: JSON.stringify({
          ok: false,
          error: "Aucun tournoi extrait — la structure de la page source a peut-être changé.",
          fetchedAt: new Date().toISOString()
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
      body: JSON.stringify({
        ok: true,
        source: "padelmagazine",
        fetchedAt: new Date().toISOString(),
        count: tournaments.length,
        tournaments
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(err && err.message || err) })
    };
  }
}
