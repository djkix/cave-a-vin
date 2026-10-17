import { Link } from 'react-router-dom';

/** Règles de confidentialité : page publique (lien de l'écran de consentement Google et de l'écran de connexion). */
export function ConfidentialitePage() {
  return (
    <main className="page" style={{ maxWidth: 680, margin: '0 auto', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 24 }}>Règles de confidentialité de Ma Cave</h1>
      <p>Ma Cave est une application personnelle de gestion de cave à vin, hébergée par son administrateur sur son propre serveur.</p>
      <h2 style={{ fontSize: 18 }}>Données conservées</h2>
      <ul>
        <li>Votre adresse e-mail et votre nom, transmis par Google à la connexion.</li>
        <li>Le contenu de votre cave : vins, bouteilles, entrées et sorties, emplacements, notes, cotes saisies, photos d'étiquettes et de la cave.</li>
        <li>Un cookie de session, seulement pour vous garder connecté.</li>
      </ul>
      <h2 style={{ fontSize: 18 }}>Services tiers</h2>
      <ul>
        <li>Google, pour la connexion (« Se connecter avec Google »).</li>
        <li>Google Gemini, qui reçoit les photos d'étiquettes pour les lire, et le nom des vins et des domaines pour proposer des accords et des descriptifs.</li>
        <li>Open Food Facts, interrogé avec le nom d'un vin quand vous cherchez une image d'étiquette.</li>
      </ul>
      <p>Aucune donnée n'est vendue ni utilisée à des fins publicitaires, et l'application ne contient aucun outil de suivi.</p>
      <h2 style={{ fontSize: 18 }}>Partage</h2>
      <p>Votre cave n'est visible que par vous et par les personnes que vous y invitez, en lecture seule.</p>
      <h2 style={{ fontSize: 18 }}>Suppression</h2>
      <p>Pour faire supprimer votre compte et votre cave, contactez l'administrateur de l'application : il efface les données de son serveur.</p>
      <p><Link to="/login">Retour à la connexion</Link></p>
    </main>
  );
}
