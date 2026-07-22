// /api/fedapay-webhook.js
// FedaPay appelle CETTE fonction directement, serveur à serveur, à chaque changement
// de statut d'une transaction — indépendamment de ce qui se passe dans le navigateur
// du client (pas de dépendance à localStorage, pas de risque de perte si le client
// change d'appareil ou ferme son navigateur pendant la confirmation Mobile Money).
//
// C'est aussi ça qui empêche les fausses commandes : ce fichier est le SEUL endroit
// qui peut marquer une commande "approved", et il vérifie d'abord la signature
// cryptographique envoyée par FedaPay pour être sûr que l'événement vient bien d'eux.
//
// Variables d'environnement Vercel nécessaires :
//   FEDAPAY_WEBHOOK_SECRET   → obtenue dans FedaPay : Paramètres → Webhooks
//   FIREBASE_PROJECT_ID      → depuis la clé de compte de service Firebase
//   FIREBASE_CLIENT_EMAIL    → idem
//   FIREBASE_PRIVATE_KEY     → idem (voir instructions fournies séparément)

import crypto from 'crypto';
import admin from 'firebase-admin';

// Vercel doit nous laisser le corps BRUT de la requête (non re-formaté), sinon le
// calcul de la signature ne correspondra jamais à celle envoyée par FedaPay.
export const config = { api: { bodyParser: false } };

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
}
const db = admin.firestore();

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    console.error("FEDAPAY_WEBHOOK_SECRET manquante dans les variables d'environnement Vercel");
    return res.status(500).json({ error: 'Configuration webhook manquante côté serveur' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Corps de requête illisible' });
  }

  // ── Vérification de la signature (essentiel : sans ça, n'importe qui pourrait
  // fabriquer une fausse notification de paiement réussi) ──
  const sigHeader = req.headers['x-fedapay-signature'];
  if (!sigHeader) {
    console.error('Webhook FedaPay : en-tête de signature manquant');
    return res.status(400).json({ error: 'Signature manquante' });
  }
  let signatureValide = false;
  try {
    // Format attendu : "t=<timestamp>,s=<signature>"
    const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
    const signedPayload = parts.t ? `${parts.t}.${rawBody}` : rawBody;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
    const provided = parts.s || sigHeader;
    signatureValide = provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch (e) {
    signatureValide = false;
  }
  if (!signatureValide) {
    console.error('Webhook FedaPay : signature invalide — requête ignorée');
    return res.status(400).json({ error: 'Signature invalide' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  const transaction = event.entity || event.data?.object || {};
  const transactionId = transaction.id;
  const eventName = event.name;
  if (!transactionId) {
    return res.status(400).json({ error: 'ID de transaction manquant dans le webhook' });
  }

  let statut;
  if (eventName === 'transaction.approved') statut = 'approved';
  else if (eventName === 'transaction.canceled') statut = 'canceled';
  else if (eventName === 'transaction.declined') statut = 'declined';
  else {
    // Autres événements (transaction.created, transaction.transferred, etc.) : rien à faire ici
    return res.status(200).json({ ignored: true });
  }

  try {
    const meta = transaction.custom_metadata || {};
    let articles = [];
    try { articles = JSON.parse(meta.articles || '[]'); } catch (e) { articles = []; }

    const ref = db.collection('commandes').doc(String(transactionId));
    const snapAvant = await ref.get();
    // Idempotence : si FedaPay renvoie deux fois le même événement "approved" (ça
    // arrive), on ne renvoie l'email qu'une seule fois.
    const emailDejaEnvoye = snapAvant.exists && snapAvant.data().confirmeParWebhook;

    await ref.set({
      transactionId,
      statut,
      montant: transaction.amount,
      client: { prenom: meta.prenom, nom: meta.nom, phone: meta.phone, email: meta.email },
      livraison: { mode: meta.mode, adresse: meta.adresse, ville: meta.ville, notes: meta.notes },
      articles,
      confirmeParWebhook: true,
      dateCreation: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (statut === 'approved' && !emailDejaEnvoye) {
      try {
        await fetch(`https://${req.headers.host}/api/notifier-commande`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transactionId, prenom: meta.prenom, nom: meta.nom, phone: meta.phone, email: meta.email,
            adresse: meta.adresse, ville: meta.ville, notes: meta.notes,
            montant: transaction.amount, mode: meta.mode, articles
          })
        });
      } catch (e) {
        console.error('Erreur notification email (webhook) :', e);
        // On ne fait pas échouer le webhook pour autant — la commande est déjà enregistrée
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur traitement webhook FedaPay :', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
