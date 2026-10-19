# MTECHBENIN Backend

API REST — Node.js + Express + Prisma + PostgreSQL

## Stack

- Node.js 20 + Express.js
- Prisma ORM + PostgreSQL (Supabase)
- Redis (Upstash)
- Resend (emails)
- Baileys (notifications WhatsApp — sans Chrome)
- FedaPay (paiement Mobile Money + Visa/MasterCard)
- BOT IMAP (interception OTP abonnements)

## Setup

```bash
# Installer les dépendances
npm install

# Configurer les variables d'environnement
cp .env.example .env
# → Remplir les valeurs dans .env

# Générer le client Prisma + migrer la base
npm run db:generate
npm run db:push

# Démarrer en développement
npm run dev
```

## Variables d'environnement requises

```env
DATABASE_URL=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
JWT_SECRET=
JWT_REFRESH_SECRET=
FEDAPAY_SECRET_KEY=       # sk_sandbox_xxxx ou sk_live_xxxx
FEDAPAY_PUBLIC_KEY=       # pk_sandbox_xxxx ou pk_live_xxxx
FEDAPAY_WEBHOOK_SECRET=   # wh_sandbox_xxxx
FEDAPAY_ENV=              # sandbox ou live
RESEND_API_KEY=
RESEND_FROM_EMAIL=
ADMIN_EMAIL=
VENDOR_WHATSAPP_NUMBER=
QR_SECRET=
AES_SECRET_KEY=
IMAP_EMAIL=
IMAP_PASSWORD=
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
FRONTEND_URL=
NODE_ENV=
```

## Routes principales

| Route                              | Méthode | Description                            |
| ---------------------------------- | ------- | -------------------------------------- |
| /health                            | GET     | Keep-alive Render + statut WhatsApp    |
| /api/auth/login                    | POST    | Login admin                            |
| /api/orders                        | POST    | Créer commande                         |
| /api/orders/:ref                   | GET     | Suivi commande                         |
| /api/payments/webhook              | POST    | Webhook FedaPay (transaction.approved) |
| /api/coupons/validate              | POST    | Valider coupon                         |
| /api/products                      | GET     | Liste produits                         |
| /api/settings/public               | GET     | Paramètres publics                     |
| /api/subscriptions                 | GET     | Liste services abonnements             |
| /api/subscriptions/order           | POST    | Créer commande abonnement              |
| /api/subscriptions/admin/dashboard | GET     | Dashboard abonnements admin            |
| /api/whatsapp/qr                   | GET     | QR code WhatsApp (JSON)                |
| /api/whatsapp/qr/scan              | GET     | QR code WhatsApp (page HTML scannable) |

## WhatsApp — Scanner le QR en production

Page HTML avec QR image — s'actualise toutes les 30 secondes.

## Déploiement

| Service  | Plateforme     | Plan                 |
| -------- | -------------- | -------------------- |
| Frontend | Vercel Hobby   | Gratuit              |
| Backend  | Render Starter | $7/mois              |
| Database | Supabase Free  | Gratuit              |
| Redis    | Upstash Free   | Gratuit              |
| Emails   | Resend Free    | Gratuit (3 000/mois) |

> UptimeRobot pinge `/health` toutes les 14 min pour éviter le spin-down.
