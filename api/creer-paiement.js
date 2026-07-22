// /api/creer-paiement.js
// Crée une transaction FedaPay et renvoie un lien de paiement (mode "redirection").
// On abandonne le widget Checkout.js (qui charge la page de paiement dans une iframe
// bloquée par les navigateurs modernes à cause des cookies tiers) au profit d'une
// redirection complète : le client quitte temporairement le site pour la vraie page
// de paiement FedaPay, puis revient automatiquement grâce au callback_url.
//
// Nécessite la variable d'environnement FEDAPAY_SECRET_KEY sur Vercel
// (Settings → Environment Variables). Ne JAMAIS mettre cette clé dans index.html —
// elle reste uniquement ici, côté serveur.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
  if (!SECRET_KEY) {
    console.error("FEDAPAY_SECRET_KEY manquante dans les variables d'environnement Vercel");
    return res.status(500).json({ error: 'Configuration de paiement manquante côté serveur' });
  }

  try {
    const { montant, description, prenom, nom, email, phone, callbackUrl, adresse, ville, notes, mode, articles } = req.body || {};
    if (!montant || !phone) {
      return res.status(400).json({ error: 'Données de paiement incomplètes' });
    }

    // La clé secrète sandbox commence par sk_sandbox_, la clé live par sk_live_ —
    // on choisit automatiquement la bonne base d'API en fonction de la clé fournie.
    const apiBase = SECRET_KEY.startsWith('sk_sandbox_')
      ? 'https://sandbox-api.fedapay.com/v1'
      : 'https://api.fedapay.com/v1';

    // FedaPay attend le numéro LOCAL (sans indicatif +229), l'indicatif étant
    // précisé séparément via "country".
    let phoneLocal = String(phone).replace(/[^0-9]/g, '');
    if (phoneLocal.startsWith('229')) phoneLocal = phoneLocal.slice(3);

    // On glisse toutes les infos de la commande dans les métadonnées personnalisées
    // de la transaction. FedaPay nous les renverra telles quelles dans le webhook
    // (/api/fedapay-webhook.js) — ainsi, la commande peut être enregistrée et l'email
    // envoyé de façon fiable, même si le client ferme son navigateur ou change
    // d'appareil pendant le paiement Mobile Money.
    const customMetadata = {
      prenom: prenom || '', nom: nom || '', phone: phone || '', email: email || '',
      adresse: adresse || '', ville: ville || '', notes: notes || '', mode: mode || '',
      articles: JSON.stringify(articles || [])
    };

    // 1. Création de la transaction
    const createRes = await fetch(`${apiBase}/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: Math.round(Number(montant)),
        description: description || 'Commande BSSD Alimentation',
        currency: { iso: 'XOF' },
        callback_url: callbackUrl,
        custom_metadata: customMetadata,
        customer: {
          firstname: prenom || 'Client',
          lastname: nom || 'BSSD',
          email: email,
          phone_number: { number: phoneLocal, country: 'bj' }
        }
      })
    });

    const createData = await createRes.json();
    if (!createRes.ok) {
      console.error('Erreur création transaction FedaPay :', createData);
      return res.status(502).json({ error: createData?.message || 'Échec de la création de la transaction' });
    }
    // Selon la version de l'API, la transaction créée peut être renvoyée directement
    // ou enveloppée sous une clé "v1/transaction" — on gère les deux cas.
    const transactionId = createData?.['v1/transaction']?.id || createData?.id || createData?.transaction?.id;
    if (!transactionId) {
      console.error('Réponse FedaPay inattendue (création) :', createData);
      return res.status(502).json({ error: 'Réponse inattendue de FedaPay lors de la création' });
    }

    // 2. Génération du lien de paiement (token) à partir de l'ID de la transaction
    const tokenRes = await fetch(`${apiBase}/transactions/${transactionId}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData?.url) {
      console.error('Erreur génération token FedaPay :', tokenData);
      return res.status(502).json({ error: 'Échec de la génération du lien de paiement' });
    }

    return res.status(200).json({ transactionId, url: tokenData.url });
  } catch (err) {
    console.error('Erreur creer-paiement :', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
