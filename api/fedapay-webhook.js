// /api/fedapay-webhook.js
// Reçoit les notifications serveur-à-serveur envoyées par FedaPay et enregistre
// la commande dans Firestore de façon fiable — même si le client a fermé son
// navigateur juste après avoir payé.
//
// Variables d'environnement à définir dans Vercel (Project Settings → Environment Variables) :
//   FEDAPAY_WEBHOOK_SECRET     -> la clé "wh_live_..." copiée depuis le dashboard FedaPay
//   FIREBASE_SERVICE_ACCOUNT   -> le CONTENU COMPLET du fichier JSON de compte de service,
//                                 collé tel quel (Vercel accepte le JSON multi-lignes dans une variable)

const crypto = require('crypto');
const admin = require('firebase-admin');

// Initialise Firebase Admin une seule fois (les fonctions serverless peuvent être réutilisées
// entre invocations, réinitialiser à chaque appel provoquerait une erreur)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Vercel désactive le body-parsing automatique pour pouvoir vérifier la signature
// sur le corps BRUT de la requête (obligatoire, sinon la signature ne correspondra jamais)
export const config = {
  api: { bodyParser: false }
};

function lireCorpsBrut(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Vérifie la signature X-FEDAPAY-SIGNATURE (format : "t=timestamp,s=signature")
function verifierSignature(payloadBrut, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('='))
  );
  const timestamp = parts.t;
  const signatureRecue = parts.s;
  if (!timestamp || !signatureRecue) return false;

  const signaturePayload = `${timestamp}.${payloadBrut}`;
  const signatureAttendue = crypto
    .createHmac('sha256', secret)
    .update(signaturePayload)
    .digest('hex');

  // Rejette les webhooks trop vieux (> 5 min) pour éviter les attaques par rejeu
  const ageSecondes = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSecondes > 300) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureAttendue, 'utf8'),
      Buffer.from(signatureRecue, 'utf8')
    );
  } catch {
    return false; // longueurs différentes = signature invalide
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Méthode non autorisée');
    return;
  }

  const payloadBrut = await lireCorpsBrut(req);
  const signatureHeader = req.headers['x-fedapay-signature'];
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET;

  if (!verifierSignature(payloadBrut, signatureHeader, secret)) {
    console.error('Signature FedaPay invalide — requête rejetée');
    res.status(400).send('Signature invalide');
    return;
  }

  let event;
  try {
    event = JSON.parse(payloadBrut);
  } catch {
    res.status(400).send('JSON invalide');
    return;
  }

  // On répond 200 rapidement puis on traite — FedaPay recommande de répondre vite
  res.status(200).send('OK');

  try {
    const transaction = event.entity;
    if (!transaction || !transaction.id) return;

    const refCommande = db.collection('commandes').doc(String(transaction.id));

    if (event.name === 'transaction.approved') {
      // merge:true -> si le client a déjà créé un brouillon de commande côté navigateur,
      // on complète/écrase juste le statut au lieu de créer un doublon
      await refCommande.set(
        {
          transactionId: transaction.id,
          statut: 'approved',
          montant: transaction.amount,
          reference: transaction.reference,
          confirmeParWebhook: true,
          dateConfirmationServeur: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    } else if (event.name === 'transaction.declined' || event.name === 'transaction.canceled') {
      await refCommande.set(
        {
          transactionId: transaction.id,
          statut: event.name === 'transaction.canceled' ? 'canceled' : 'declined',
          confirmeParWebhook: true,
          dateConfirmationServeur: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
    // Les autres événements (transaction.created, etc.) ne sont pas critiques : on les ignore
  } catch (err) {
    // On a déjà répondu 200 à FedaPay, donc on se contente de logger côté serveur
    console.error('Erreur traitement webhook FedaPay :', err);
  }
};
