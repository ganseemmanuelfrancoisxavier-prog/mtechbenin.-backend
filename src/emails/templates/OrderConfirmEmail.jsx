import { Section, Text, Button } from '@react-email/components';
import { Layout } from './components/Layout.jsx';

export function OrderConfirmEmail({ order }) {
  const hasDelivery = !!order.city;
  const frontendUrl = process.env.FRONTEND_URL || 'https://mtechbenin.com';

  return (
    <Layout preview={`Commande ${order.reference} confirmée — paiement reçu ✅`}>
      <Text style={h1}>Commande confirmée ✅</Text>
      <Text style={p}>
        Bonjour <strong>{order.guestName}</strong>,
      </Text>
      <Text style={p}>
        Votre commande <strong>{order.reference}</strong> a été confirmée et le paiement validé avec succès.
      </Text>

      {order.isGift && order.giftName && (
        <Section style={giftBox}>
          <Text style={{ ...label, color: '#9A3412' }}>🎁 Cadeau pour {order.giftName}</Text>
          <Text style={{ margin: '0', color: '#9A3412', fontSize: '13px' }}>
            Les identifiants seront envoyés directement au destinataire.
          </Text>
        </Section>
      )}

      {hasDelivery ? (
        <Section style={infoBox}>
          <Text style={label}>📦 Livraison</Text>
          <Text style={line}>
            <strong>Ville :</strong> {order.city}
            {order.neighborhood ? `, ${order.neighborhood}` : ''}
          </Text>
          <Text style={line}><strong>Créneau :</strong> {order.deliverySlot || '—'}</Text>
          {order.instructions && (
            <Text style={line}><strong>Instructions :</strong> {order.instructions}</Text>
          )}
        </Section>
      ) : (
        <Section style={successBox}>
          <Text style={{ margin: '0', color: '#166534' }}>
            📲 Votre accès numérique sera envoyé très prochainement sur WhatsApp.
          </Text>
        </Section>
      )}

      <Section style={infoBox}>
        <Text style={label}>💰 Récapitulatif</Text>
        {order.discount > 0 && (
          <Text style={{ ...line, color: '#16A34A' }}>
            <strong>Réduction :</strong> -{order.discount.toLocaleString('fr-FR')} FCFA
          </Text>
        )}
        {hasDelivery && order.deliveryFee > 0 && (
          <Text style={line}>
            <strong>Frais de livraison :</strong> {order.deliveryFee.toLocaleString('fr-FR')} FCFA
          </Text>
        )}
        <Text style={{ margin: '8px 0 0', fontSize: '18px', fontWeight: '700', color: '#1D1D1F' }}>
          Total réglé : {order.total.toLocaleString('fr-FR')} FCFA
        </Text>
      </Section>

      <Section style={{ textAlign: 'center', margin: '28px 0' }}>
        <Button href={`${frontendUrl}/suivi/${order.reference}`} style={cta}>
          Suivre ma commande →
        </Button>
      </Section>
    </Layout>
  );
}

const h1 = { fontSize: '24px', fontWeight: '700', color: '#1D1D1F', margin: '0 0 12px' };
const p = { fontSize: '15px', color: '#3D3D3F', margin: '6px 0' };
const line = { margin: '4px 0', fontSize: '14px', color: '#3D3D3F' };
const label = { margin: '0 0 8px', fontWeight: '600', color: '#1D1D1F', fontSize: '14px' };
const infoBox = { backgroundColor: '#F5F5F7', padding: '16px', borderRadius: '12px', margin: '16px 0' };
const giftBox = { backgroundColor: '#FFF7ED', padding: '16px', borderRadius: '12px', margin: '16px 0', borderLeft: '4px solid #F97316' };
const successBox = { backgroundColor: '#F0FDF4', padding: '16px', borderRadius: '12px', margin: '16px 0', borderLeft: '4px solid #22C55E' };
const cta = { backgroundColor: '#1D1D1F', color: '#ffffff', padding: '12px 28px', borderRadius: '8px', textDecoration: 'none', fontWeight: '600', fontSize: '15px', display: 'inline-block' };

// Preview avec données d'exemple
export default function Preview() {
  return (
    <OrderConfirmEmail
      order={{
        reference: 'MTB-2026-001',
        guestName: 'Kofi Mensah',
        guestEmail: 'kofi@example.com',
        city: 'Cotonou',
        neighborhood: 'Cadjehoun',
        deliverySlot: '10h – 12h',
        instructions: null,
        isGift: false,
        discount: 2000,
        deliveryFee: 1000,
        total: 24000,
        items: [],
      }}
    />
  );
}
