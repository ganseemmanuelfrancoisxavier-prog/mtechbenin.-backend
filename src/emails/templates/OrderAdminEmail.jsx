import { Section, Text, Button, Link } from '@react-email/components';
import { Layout } from './components/Layout.jsx';

export function OrderAdminEmail({ order }) {
  const hasDelivery = !!order.city;
  const frontendUrl = process.env.FRONTEND_URL || 'https://mtechbenin.com';

  return (
    <Layout preview={`🛎️ Nouvelle commande ${order.reference}${hasDelivery ? ' — À préparer' : ' — Numérique'}`}>
      <Text style={h1}>Nouvelle commande — {order.reference}</Text>

      <Section style={infoBox}>
        <Text style={label}>👤 Client</Text>
        <Text style={line}>Nom : <strong>{order.guestName}</strong></Text>
        <Text style={line}>WhatsApp : <strong>{order.guestWhatsapp}</strong></Text>
        {order.guestEmail && <Text style={line}>Email : {order.guestEmail}</Text>}
      </Section>

      {order.isGift && order.giftName && (
        <Section style={giftBox}>
          <Text style={{ ...label, color: '#9A3412' }}>🎁 Cadeau pour : {order.giftName}</Text>
          <Text style={{ margin: '0', color: '#9A3412', fontSize: '13px' }}>
            WhatsApp destinataire : {order.giftWhatsapp}
          </Text>
        </Section>
      )}

      {hasDelivery ? (
        <Section style={infoBox}>
          <Text style={label}>📦 Livraison</Text>
          <Text style={line}>Ville : <strong>{order.city}</strong></Text>
          {order.neighborhood && <Text style={line}>Quartier : <strong>{order.neighborhood}</strong></Text>}
          <Text style={line}>Créneau : <strong>{order.deliverySlot || 'Non précisé'}</strong></Text>
          {order.instructions && <Text style={line}>Instructions : <em>{order.instructions}</em></Text>}
          {order.deliveryLat && order.deliveryLng && (
            <Text style={line}>
              <Link href={`https://www.google.com/maps?q=${order.deliveryLat},${order.deliveryLng}`}>
                📍 Voir la position GPS
              </Link>
            </Text>
          )}
        </Section>
      ) : (
        <Section style={successBox}>
          <Text style={{ margin: '0', color: '#166534' }}>
            📲 Commande numérique — identifiants envoyés automatiquement.
          </Text>
        </Section>
      )}

      <Section style={infoBox}>
        <Text style={label}>🛒 Articles</Text>
        {order.items.map((item, i) => (
          <Text key={i} style={line}>
            • {item.productName} × {item.quantity} —{' '}
            <strong>{item.totalPrice.toLocaleString('fr-FR')} FCFA</strong>
          </Text>
        ))}
      </Section>

      <Section style={infoBox}>
        {order.discount > 0 && (
          <Text style={{ ...line, color: '#16A34A' }}>
            Réduction : -{order.discount.toLocaleString('fr-FR')} FCFA
          </Text>
        )}
        {hasDelivery && order.deliveryFee > 0 && (
          <Text style={line}>Livraison : {order.deliveryFee.toLocaleString('fr-FR')} FCFA</Text>
        )}
        <Text style={{ margin: '8px 0 0', fontSize: '18px', fontWeight: '700', color: '#1D1D1F' }}>
          💰 Total encaissé : {order.total.toLocaleString('fr-FR')} FCFA
        </Text>
      </Section>

      {hasDelivery && (
        <Section style={alertBox}>
          <Text style={{ margin: '0', fontWeight: '700', color: '#DC2626', fontSize: '16px' }}>
            ⚠️ ACTION REQUISE
          </Text>
          <Text style={{ margin: '8px 0 12px', color: '#7F1D1D' }}>
            Préparez et expédiez cette commande dès que possible.
            Mettez à jour le statut dans le panel admin une fois envoyée.
          </Text>
          <Button href={`${frontendUrl}/admin/commandes`} style={alertCta}>
            Gérer la commande →
          </Button>
        </Section>
      )}
    </Layout>
  );
}

const h1 = { fontSize: '22px', fontWeight: '700', color: '#1D1D1F', margin: '0 0 16px' };
const line = { margin: '3px 0', fontSize: '14px', color: '#3D3D3F' };
const label = { margin: '0 0 6px', fontWeight: '600', color: '#1D1D1F', fontSize: '14px' };
const infoBox = { backgroundColor: '#F5F5F7', padding: '12px 16px', borderRadius: '8px', margin: '12px 0' };
const giftBox = { backgroundColor: '#FFF7ED', padding: '12px 16px', borderRadius: '8px', margin: '12px 0', borderLeft: '4px solid #F97316' };
const successBox = { backgroundColor: '#F0FDF4', padding: '12px 16px', borderRadius: '8px', margin: '12px 0', borderLeft: '4px solid #22C55E' };
const alertBox = { backgroundColor: '#FEF2F2', padding: '16px', borderRadius: '8px', margin: '20px 0', border: '2px solid #DC2626' };
const alertCta = { backgroundColor: '#DC2626', color: '#ffffff', padding: '10px 20px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', display: 'inline-block' };

// Preview avec données d'exemple
export default function Preview() {
  return (
    <OrderAdminEmail
      order={{
        reference: 'MTB-2026-001',
        guestName: 'Kofi Mensah',
        guestWhatsapp: '+22997001122',
        guestEmail: 'kofi@example.com',
        city: 'Cotonou',
        neighborhood: 'Cadjehoun',
        deliverySlot: '14h – 16h',
        instructions: 'Appeler avant de passer',
        isGift: true,
        giftName: 'Marisol',
        giftWhatsapp: '+22997000000',
        discount: 500,
        deliveryFee: 1000,
        total: 24500,
        deliveryLat: 6.3677,
        deliveryLng: 2.42,
        items: [
          { productName: 'Netflix Premium 4K', quantity: 1, totalPrice: 25000 },
        ],
      }}
    />
  );
}
