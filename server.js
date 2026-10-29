/**
 * server.js — Le Juste Prix · Serveur de jeu en temps réel
 * Zéro dépendance (Node.js natif uniquement)
 * Lancer : node server.js
 * Accès admin  : http://localhost:3000  (index.html)
 * Accès joueur : http://localhost:3000/joueur  (depuis le smartphone)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ======================================================================
// ÉTAT EN MÉMOIRE
// ======================================================================

/*
  session = {
    code        : string (6 lettres)
    teams       : string[]           (noms des équipes, fixés par l'animateur)
    connected   : { [teamIndex]: socketId }  // capitaine connecté par équipe
    phase       : 'lobby' | 'waiting' | 'answering' | 'closed'
    question    : {
      epreuve   : 1|2|3|4
      index     : number
      type      : 'qcm' | 'prix' | 'panier' | 'plusmoins'
      // données affichées sur les smartphones (pas les réponses correctes !)
      label     : string
      choices   : string[]|null      // E1 : ['A:3,85€','B:4,50€','C:5,75€','D:7,20€']
      prixPropose: number|null        // E4 seulement
    } | null
    openedAt    : number | null      // Date.now() quand answering démarre
    answers     : { [teamIndex]: { value, timestamp } }
    epreuveData : objet complet de l'épreuve (copié depuis index.html state)
  }
*/

let session = null;

// ======================================================================
// UTILITAIRES
// ======================================================================

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function badRequest(res, msg) {
  json(res, { error: msg }, 400);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ct = contentType.startsWith('text/') ? contentType + '; charset=utf-8' : contentType;
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch(e) { reject(e); }
    });
  });
}

// Retourne l'état public visible par les joueurs (sans les réponses correctes)
function publicSession() {
  if (!session) return null;
  return {
    code     : session.code,
    teams    : session.teams,
    connected: session.connected,
    phase    : session.phase,
    question : session.question,
    openedAt : session.openedAt,
    answers  : session.answers   // on expose les réponses (l'animateur les voit en live)
  };
}

// ======================================================================
// SERVEUR HTTP
// ======================================================================

const server = http.createServer(async (req, res) => {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ---------- Fichiers statiques ----------

  // Page joueur
  if (pathname === '/joueur' || pathname === '/joueur.html') {
    return serveFile(res, path.join(ROOT, 'joueur.html'), 'text/html');
  }

  // Page admin (index.html)
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(ROOT, 'index.html'), 'text/html');
  }

  // Images et autres ressources statiques
  if (pathname.startsWith('/images/')) {
    const ext = path.extname(pathname).toLowerCase();
    const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    return serveFile(res, path.join(ROOT, pathname), types[ext] || 'application/octet-stream');
  }

  // ---------- API ----------

  if (!pathname.startsWith('/api/')) {
    res.writeHead(404); res.end('Not found'); return;
  }

  // ── POST /api/session/create  (animateur crée la session)
  if (pathname === '/api/session/create' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.teams || !Array.isArray(body.teams) || body.teams.length === 0) {
      return badRequest(res, 'teams requis');
    }
    session = {
      code       : genCode(),
      teams      : body.teams,
      connected  : {},
      phase      : 'lobby',
      question   : null,
      openedAt   : null,
      answers    : {},
      epreuveData: body.epreuveData || null
    };
    console.log(`[SERVER] Session créée : ${session.code} — ${session.teams.length} équipes`);
    return json(res, { code: session.code });
  }

  // ── GET /api/session  (état courant — polled par admin et joueurs)
  if (pathname === '/api/session' && req.method === 'GET') {
    if (!session) return json(res, { session: null });
    return json(res, { session: publicSession() });
  }

  // ── POST /api/session/update-data  (sync epreuveData depuis l'admin)
  if (pathname === '/api/session/update-data' && req.method === 'POST') {
    if (!session) return badRequest(res, 'Pas de session active');
    const body = await parseBody(req);
    if (body.epreuveData) session.epreuveData = body.epreuveData;
    if (body.teams) session.teams = body.teams;
    return json(res, { ok: true });
  }

  // ── POST /api/join  (capitaine rejoint avec son code + choix d'équipe)
  if (pathname === '/api/join' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!session) return badRequest(res, 'Pas de session active');
    if (body.code !== session.code) return badRequest(res, 'Code invalide');
    if (typeof body.teamIndex !== 'number') return badRequest(res, 'teamIndex requis');
    if (body.teamIndex < 0 || body.teamIndex >= session.teams.length) return badRequest(res, 'Équipe invalide');
    if (session.connected[body.teamIndex] !== undefined) return badRequest(res, 'Cette équipe est déjà connectée');

    session.connected[body.teamIndex] = body.playerId || String(Date.now());
    console.log(`[SERVER] ${session.teams[body.teamIndex]} connectée (${Object.keys(session.connected).length}/${session.teams.length})`);
    return json(res, { ok: true, teamIndex: body.teamIndex, teamName: session.teams[body.teamIndex] });
  }

  // ── POST /api/question/open  (animateur ouvre la saisie — "RÉPONDEZ !")
  if (pathname === '/api/question/open' && req.method === 'POST') {
    if (!session) return badRequest(res, 'Pas de session');
    const body = await parseBody(req);
    // body.question = { epreuve, index, type, label, choices, prixPropose }
    session.question = body.question;
    session.phase    = 'answering';
    session.openedAt = Date.now();
    session.answers  = {};
    console.log(`[SERVER] Question ouverte — E${body.question.epreuve} Q${body.question.index + 1}`);
    return json(res, { ok: true });
  }

  // ── POST /api/question/close  (animateur ferme la saisie)
  if (pathname === '/api/question/close' && req.method === 'POST') {
    if (!session) return badRequest(res, 'Pas de session');
    session.phase = 'closed';
    console.log(`[SERVER] Question fermée — ${Object.keys(session.answers).length} réponse(s) reçue(s)`);
    return json(res, { ok: true, answers: session.answers });
  }

  // ── POST /api/answer  (capitaine soumet sa réponse)
  if (pathname === '/api/answer' && req.method === 'POST') {
    if (!session) return badRequest(res, 'Pas de session');
    if (session.phase !== 'answering') return badRequest(res, 'La saisie est fermée');
    const body = await parseBody(req);
    if (typeof body.teamIndex !== 'number') return badRequest(res, 'teamIndex requis');
    if (body.value === undefined || body.value === null) return badRequest(res, 'value requis');
    if (session.answers[body.teamIndex] !== undefined) return badRequest(res, 'Réponse déjà enregistrée');

    const elapsed = Date.now() - session.openedAt;
    session.answers[body.teamIndex] = {
      value    : body.value,
      timestamp: elapsed   // ms depuis l'ouverture de la question
    };
    console.log(`[SERVER] Réponse de ${session.teams[body.teamIndex]} : ${body.value} (${elapsed}ms)`);
    return json(res, { ok: true, timestamp: elapsed });
  }

  // ── POST /api/session/reset  (nouvelle partie ou retour lobby)
  if (pathname === '/api/session/reset' && req.method === 'POST') {
    if (!session) return badRequest(res, 'Pas de session');
    session.phase    = 'lobby';
    session.question = null;
    session.openedAt = null;
    session.answers  = {};
    return json(res, { ok: true });
  }

  // ── POST /api/session/destroy  (fin totale)
  if (pathname === '/api/session/destroy' && req.method === 'POST') {
    session = null;
    console.log('[SERVER] Session détruite');
    return json(res, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       LE JUSTE PRIX — Serveur de jeu             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Admin  → http://localhost:${PORT}                   ║`);
  console.log(`║  Joueur → http://localhost:${PORT}/joueur             ║`);
  console.log('║                                                  ║');
  console.log('║  Sur le réseau local, remplacer localhost par    ║');
  console.log('║  l\'adresse IP de cette machine (ex: 192.168.x.x) ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
