// src/index.js — Cloudflare Worker (modèle "Workers + static assets", 2026)
//
// Ce modèle remplace l'ancien "Cloudflare Pages" pour les nouveaux projets
// connectés à Git. Contrairement à Pages, il n'y a pas de dossier
// `functions/` auto-routé : un seul point d'entrée (ce fichier) gère à la
// fois le routage vers le scraper ET le service des fichiers statiques
// (via le binding ASSETS, configuré dans wrangler.jsonc).
//
// Logique de scraping identique à functions/get-tournaments.js (l'ancienne
// tentative "Pages Functions", désormais inutilisée mais laissée dans le
// repo sans danger) — copiée ici car ce modèle ne lit pas ce dossier.

const SOURCE_URL = "https://tournois.padelmagazine.fr/ligues/reunion";
const CACHE_TTL_SECONDS = 900; // 15 minutes

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

const DATE_RE = /(\d{1,2})\s+([a-zéû.]+)\.?\s+(\d{4})/gi;
const TIER_RE = /\bP(25|50|100|250|500|1000|1500|2000)\b[^\n]{0,60}/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const CLUB_LABEL_RE = /^club\s*:?\s*$/i;

const LABEL_WORDS = new Set([
  "club", "arbitre", "tournoi", "adresse", "contact", "email", "mail",
  "telephone", "téléphone", "horaires", "informations", "inscription",
  "date", "categorie", "catégorie"
]);
function looksLikeClubName(line) {
  if (!line || line.length > 80) return false;
  if (EMAIL_RE.test(line)) return false;
  if (/^\d/.test(line)) return false;
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
      const found = KNOWN_CLUBS.find(c => line.toUpperCase().includes(c));
      if (found) { current.club = found; continue; }

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

function jsonResponse(payload, status = 200, cacheable = false) {
  const headers = { "Content-Type": "application/json" };
  if (cacheable) headers["Cache-Control"] = `public, max-age=${CACHE_TTL_SECONDS}`;
  return new Response(JSON.stringify(payload), { status, headers });
}

async function handleTournaments(request, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PadelReunionCalendarBot/1.0)" }
    });

    if (!res.ok) {
      return jsonResponse({ ok: false, error: `Upstream returned ${res.status}` }, 502);
    }

    const html = await res.text();
    const tournaments = parseTournaments(html);

    if (tournaments.length === 0) {
      return jsonResponse({
        ok: false,
        error: "Aucun tournoi extrait — la structure de la page source a peut-être changé.",
        fetchedAt: new Date().toISOString()
      }, 200, true);
    }

    const response = jsonResponse({
      ok: true,
      source: "padelmagazine",
      fetchedAt: new Date().toISOString(),
      count: tournaments.length,
      tournaments
    }, 200, true);

    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/get-tournaments") {
      return handleTournaments(request, ctx);
    }

    // Tout le reste (index.html, etc.) → servi comme fichier statique
    return env.ASSETS.fetch(request);
  }
};
