import { Section, Text, Button } from '@react-email/components';
import { Layout } from './components/Layout.jsx';

// Le Bénin est à UTC+1 toute l'année, sans changement d'heure. Comme
// src/emails/index.js (la version réellement utilisée à l'envoi), on
// applique ce décalage fixe puis on lit jour/mois/année en UTC — jamais
// l'heure locale de la machine qui rend ce composant, ni
// toLocaleDateString sans fuseau explicite — pour rester cohérent avec le
// jour que workers/subscriptionExpiry.js a retenu comme « demain ».
const DECALAGE_BENIN_H = 1;
const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

function formatDateExpirationFr(expiresAt) {
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return '';
  const decale = new Date(d.getTime() + DECALAGE_BENIN_H * 3600 * 1000);
  const jour = decale.getUTCDate();
  // Le premier jour du mois s'écrit « 1ᵉʳ » en français, pas « 1 » — même
  // correctif que src/emails/index.js (la version réellement utilisée à
  // l'envoi), pour que la prévisualisation reste fidèle.
  const jourTexte = jour === 1 ? '1ᵉʳ' : String(jour);
  return `${jourTexte} ${MOIS_FR[decale.getUTCMonth()]} ${decale.getUTCFullYear()}`;
}

// `serviceSlug` est facultatif : fourni, le bouton mène directement à la page
// du service à renouveler ; absent, il retombe sur le catalogue.
export function SubExpiryReminderEmail({ clientName, serviceName, planLabel, expiresAt, serviceSlug }) {
  const frontendUrl = process.env.FRONTEND_URL || 'https://mtechbenin.com';
  const dateFr = formatDateExpirationFr(expiresAt);
  const lien = serviceSlug
    ? `${frontendUrl}/abonnements/${encodeURIComponent(serviceSlug)}`
    : `${frontendUrl}/abonnements`;

  return (
    <Layout preview={`Votre abonnement ${serviceName} expire le ${dateFr}`}>
      <Text style={h1}>Votre abonnement arrive à échéance</Text>
      <Text style={p}>Bonjour <strong>{clientName}</strong>,</Text>
      <Text style={p}>
        Votre abonnement <strong>{serviceName}</strong>, formule <strong>{planLabel}</strong>,
        expire le <strong>{dateFr}</strong>.
      </Text>

      <Section style={infoBox}>
        <Text style={{ margin: '0', color: '#3D3D3F', fontSize: '14px' }}>
          Sans renouvellement d'ici là, l'accès sera interrompu à cette date.
        </Text>
      </Section>

      <Text style={p}>
        Vous pouvez renouveler dès maintenant pour continuer à profiter de votre abonnement
        sans interruption.
      </Text>

      <Section style={{ textAlign: 'center', margin: '28px 0' }}>
        <Button href={lien} style={cta}>
          Renouveler mon abonnement →
        </Button>
      </Section>
    </Layout>
  );
}

const h1 = { fontSize: '24px', fontWeight: '700', color: '#1D1D1F', margin: '0 0 12px' };
const p = { fontSize: '15px', color: '#3D3D3F', margin: '6px 0' };
const infoBox = { backgroundColor: '#F5F5F7', padding: '16px', borderRadius: '12px', margin: '16px 0' };
const cta = { backgroundColor: '#1D1D1F', color: '#ffffff', padding: '12px 28px', borderRadius: '8px', textDecoration: 'none', fontWeight: '600', fontSize: '15px', display: 'inline-block' };

// Preview avec données d'exemple
export default function Preview() {
  return (
    <SubExpiryReminderEmail
      clientName="Kofi"
      serviceName="Netflix"
      planLabel="Standard"
      expiresAt={new Date('2026-09-12')}
    />
  );
}
