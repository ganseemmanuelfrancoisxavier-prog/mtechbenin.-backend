import { Section, Text } from '@react-email/components';
import { Layout } from './components/Layout.jsx';

export function SubCredentialsEmail({ clientName, serviceName, credentials }) {
  return (
    <Layout preview={`Votre accès ${serviceName} est prêt 🎉`}>
      <Text style={h1}>Votre abonnement est prêt ! 🎉</Text>
      <Text style={p}>Bonjour <strong>{clientName}</strong>,</Text>
      <Text style={p}>
        Votre accès <strong>{serviceName}</strong> a été activé avec succès.
        Voici vos identifiants de connexion :
      </Text>

      <Section style={credBox}>
        <Text style={label}>🔑 Identifiants de connexion</Text>
        <Text style={credLine}><strong>Email :</strong> {credentials.email}</Text>
        <Text style={credLine}><strong>Mot de passe :</strong> {credentials.password}</Text>
        {credentials.profile && (
          <Text style={credLine}><strong>Profil :</strong> {credentials.profile}</Text>
        )}
        {credentials.profilePassword && (
          <Text style={credLine}><strong>Code profil :</strong> {credentials.profilePassword}</Text>
        )}
      </Section>

      <Section style={warningBox}>
        <Text style={{ margin: '0', color: '#7F1D1D', fontWeight: '600' }}>
          ⚠️ Ne partagez pas ces identifiants avec quiconque.
        </Text>
        <Text style={{ margin: '4px 0 0', color: '#7F1D1D', fontSize: '13px' }}>
          En cas de problème d'accès, contactez-nous immédiatement sur WhatsApp.
        </Text>
      </Section>
    </Layout>
  );
}

const h1 = { fontSize: '24px', fontWeight: '700', color: '#1D1D1F', margin: '0 0 12px' };
const p = { fontSize: '15px', color: '#3D3D3F', margin: '6px 0' };
const label = { margin: '0 0 12px', fontWeight: '600', color: '#1D1D1F', fontSize: '14px' };
const credBox = { backgroundColor: '#F5F5F7', padding: '20px', borderRadius: '12px', margin: '20px 0' };
const credLine = { margin: '8px 0', fontSize: '15px', color: '#1D1D1F', fontFamily: 'monospace, monospace' };
const warningBox = { backgroundColor: '#FEF2F2', padding: '16px', borderRadius: '8px', margin: '16px 0', borderLeft: '4px solid #DC2626' };

// Preview avec données d'exemple
export default function Preview() {
  return (
    <SubCredentialsEmail
      clientName="Ama Koffi"
      serviceName="Netflix Premium"
      credentials={{
        email: 'shared@netflix.com',
        password: 'SecurePass2026!',
        profile: 'Ama',
        profilePassword: '1234',
      }}
    />
  );
}
