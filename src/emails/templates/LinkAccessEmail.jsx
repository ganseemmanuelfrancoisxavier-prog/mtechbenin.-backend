import { Section, Text, Button } from '@react-email/components';
import { Layout } from './components/Layout.jsx';

export function LinkAccessEmail({ clientName, serviceName, link }) {
  return (
    <Layout preview={`Votre accès ${serviceName} est disponible ✅`}>
      <Text style={h1}>Votre lien d'accès est prêt ! ✅</Text>
      <Text style={p}>Bonjour <strong>{clientName}</strong>,</Text>
      <Text style={p}>
        Votre accès <strong>{serviceName}</strong> est disponible.
        Cliquez sur le bouton ci-dessous pour y accéder.
      </Text>

      <Section style={{ textAlign: 'center', margin: '32px 0' }}>
        <Button href={link} style={cta}>Accéder maintenant →</Button>
      </Section>

      <Text style={hint}>
        Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :
      </Text>
      <Text style={{ ...hint, wordBreak: 'break-all', color: '#6E6E73' }}>{link}</Text>
    </Layout>
  );
}

const h1 = { fontSize: '24px', fontWeight: '700', color: '#1D1D1F', margin: '0 0 12px' };
const p = { fontSize: '15px', color: '#3D3D3F', margin: '6px 0' };
const hint = { fontSize: '12px', color: '#9CA3AF', margin: '4px 0' };
const cta = { backgroundColor: '#1D1D1F', color: '#ffffff', padding: '14px 36px', borderRadius: '8px', textDecoration: 'none', fontWeight: '600', fontSize: '16px', display: 'inline-block' };

// Preview avec données d'exemple
export default function Preview() {
  return (
    <LinkAccessEmail
      clientName="Jean Dupont"
      serviceName="Canva Pro"
      link="https://canva.com/invite/example-token-123"
    />
  );
}
