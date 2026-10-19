import { Html, Head, Body, Container, Section, Text, Preview } from '@react-email/components';

export function Layout({ children, preview }) {
  return (
    <Html lang="fr">
      <Head />
      {preview && <Preview>{preview}</Preview>}
      <Body style={body}>
        <Container style={container}>
          {/* Header */}
          <Section style={header}>
            <Text style={brand}>MTECHBENIN</Text>
          </Section>

          {children}

          {/* Footer */}
          <Section style={{ marginTop: '32px', borderTop: '1px solid #E5E7EB', paddingTop: '16px' }}>
            <Text style={footer}>
              Pour toute question, répondez à cet email ou contactez-nous sur WhatsApp.
            </Text>
            <Text style={footer}>MTECHBENIN — Votre boutique tech au Bénin</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body = { fontFamily: 'Arial, sans-serif', backgroundColor: '#F9FAFB', margin: '0', padding: '0' };
const container = { maxWidth: '600px', margin: '0 auto', padding: '24px', backgroundColor: '#ffffff' };
const header = { backgroundColor: '#1D1D1F', padding: '16px', borderRadius: '12px', textAlign: 'center', marginBottom: '24px' };
const brand = { color: '#ffffff', margin: '0', fontSize: '20px', fontWeight: 'bold', letterSpacing: '2px' };
const footer = { color: '#6E6E73', fontSize: '12px', textAlign: 'center', margin: '4px 0 0' };
