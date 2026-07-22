// /api/notifier-commande.js
// Fonction serveur Vercel : envoie un email à l'admin à chaque nouvelle commande.
// Appelée depuis index.html juste après l'enregistrement de la commande dans Firestore.
// Nécessite la variable d'environnement RESEND_API_KEY sur Vercel (Settings → Environment Variables).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY manquante dans les variables d\'environnement Vercel');
    return res.status(500).json({ error: 'Configuration email manquante côté serveur' });
  }

  try {
    const { transactionId, prenom, nom, phone, email, adresse, ville, notes, montant, mode, articles } = req.body || {};

    // Sécurité minimale : on vérifie qu'on a bien reçu l'essentiel avant d'envoyer un email
    if (!transactionId || !montant) {
      return res.status(400).json({ error: 'Données de commande incomplètes' });
    }

    // Échappement HTML basique : ces champs viennent du client final (formulaire de
    // commande) et sont insérés dans un email HTML — sans échappement, un client
    // malveillant pourrait injecter du code dans l'email reçu par l'admin.
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

    const listeArticles = Array.isArray(articles)
      ? articles.map(a => `<li>${esc(a.qte)}× ${esc(a.nom)} — ${Number(a.promo).toLocaleString('fr-FR')} FCFA</li>`).join('')
      : '';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#1f6f4a">🛒 Nouvelle commande — BSSD Alimentation</h2>
        <p><strong>N° de transaction :</strong> ${esc(transactionId)}</p>
        <p><strong>Client :</strong> ${esc(prenom)} ${esc(nom)}</p>
        <p><strong>Téléphone :</strong> ${esc(phone) || '—'}</p>
        <p><strong>Email :</strong> ${esc(email) || '—'}</p>
        <p><strong>Livraison :</strong> ${mode === 'retrait' ? 'Retrait sur place' : `${esc(mode) || '—'} — ${esc(adresse)}, ${esc(ville)}`}</p>
        ${notes ? `<p><strong>Notes :</strong> ${esc(notes)}</p>` : ''}
        <p><strong>Montant total :</strong> ${Number(montant).toLocaleString('fr-FR')} FCFA</p>
        <h3 style="margin-top:20px">Articles commandés</h3>
        <ul>${listeArticles}</ul>
        <p style="margin-top:24px;color:#777;font-size:.85rem">Consultez tous les détails dans l'onglet "📦 Commandes" de votre panneau admin.</p>
      </div>
    `;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'BSSD Alimentation <onboarding@resend.dev>',
        to: 'bssdsociete@gmail.com',
        subject: `🛒 Nouvelle commande — ${Number(montant).toLocaleString('fr-FR')} FCFA`,
        html
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Erreur envoi email Resend :', errText);
      return res.status(502).json({ error: 'Échec de l\'envoi de l\'email' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur notifier-commande :', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
