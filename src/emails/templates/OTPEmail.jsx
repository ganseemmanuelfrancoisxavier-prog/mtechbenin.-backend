import { Section, Text } from '@react-email/components';
import { Layout } from './components/Layout.jsx';

export function OTPEmail({ clientName, serviceName, otpCode }) {
  return (
    <Layout preview={`Code de vérification ${serviceName} : ${otpCode}`}>
      <Text style={h1}>Code de vérification 🔐</Text>
      <Text style={p}>Bonjour <strong>{clientName}</strong>,</Text>
      <Text style={p}>
        Voici votre code de vérification pour <strong>{serviceName}</strong> :
      </Text>

      <Section style={otpBox}>
        <Text style={otpText}>{otpCode}</Text>
      </Section>

      <Section style={warningBox}>
        <Text style={{ margin: '0', color: '#92400E', fontWeight: '600' }}>
          ⚠️ Ce code expire dans 10 minutes.
        </Text>
        <Text style={{ margin: '4px 0 0', color: '#92400E', fontSize: '13px' }}>
          Si vous n'avez pas demandé ce code, ignorez cet email.
        </Text>
      </Section>
    </Layout>
  );
}

const h1 = { fontSize: '24px', fontWeight: '700', color: '#1D1D1F', margin: '0 0 12px' };
const p = { fontSize: '15px', color: '#3D3D3F', margin: '6px 0' };
const otpBox = { backgroundColor: '#F5F5F7', padding: '28px', borderRadius: '12px', margin: '24px 0', textAlign: 'center' };
const otpText = { fontSize: '42px', fontWeight: '700', letterSpacing: '12px', color: '#1D1D1F', margin: '0', fontFamily: 'monospace, monospace' };
const warningBox = { backgroundColor: '#FFFBEB', padding: '16px', borderRadius: '8px', margin: '16px 0', borderLeft: '4px solid #F59E0B' };

// Preview avec données d'exemple
export default function Preview() {
  return (
    <OTPEmail
      clientName="Marie Adjovi"
      serviceName="Netflix"
      otpCode="482 931"
    />
  );
}
