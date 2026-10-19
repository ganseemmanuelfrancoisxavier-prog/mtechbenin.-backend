const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Démarrage du seed MTECHBENIN...");

  // ── 1. Catégories ─────────────────────────────────────────────────────────
  console.log("📁 Catégories...");
  const categoriesData = [
    {
      slug: "ecouteurs",
      name: "Écouteurs",
      label: "Écouteurs",
      icon: "🎧",
      sortOrder: 1,
      active: true,
    },
    {
      slug: "enceintes",
      name: "Enceintes",
      label: "Enceintes",
      icon: "🔊",
      sortOrder: 2,
      active: true,
    },
    {
      slug: "vapes",
      name: "Vapes",
      label: "Vapes",
      icon: "💨",
      sortOrder: 3,
      active: true,
    },
    {
      slug: "for-woman",
      name: "For Woman",
      label: "For Woman",
      icon: "💄",
      sortOrder: 4,
      active: true,
    },
    {
      slug: "accessoires",
      name: "Accessoires",
      label: "Accessoires",
      icon: "📦",
      sortOrder: 5,
      active: true,
    },
  ];

  for (const cat of categoriesData) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: cat,
      create: cat,
    });
  }
  console.log(`✅ ${categoriesData.length} catégories créées`);

  // ── 2. Produits ───────────────────────────────────────────────────────────
  console.log("📦 Produits...");
  const productsData = [
    {
      name: "AirPod Pro 2ème génération (Semi Authentic)",
      slug: "airpod-pro-2",
      categorySlug: "ecouteurs",
      price: 9750,
      comparePrice: 13650,
      stock: 15,
      status: "En stock",
      featured: true,
      active: true,
      salesCount: 47,
      description:
        "Transducteur Apple à haute excursion conçu sur mesure. Transparence adaptative. Audio spatial personnalisé avec suivi dynamique des mouvements de la tête.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/Vh1E5wolcR2kRWx9HvXoVLLMPd8UG1neURyCW9jD.webp",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Type", value: "Intra-auriculaire" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.3" },
        { id: 3, label: "Autonomie", value: "Jusqu'à 6h (30h avec boîtier)" },
        { id: 4, label: "Résistance", value: "IPX4" },
        { id: 5, label: "Compatibilité", value: "iOS / Android" },
      ]),
    },
    {
      name: "AirPod 2ème génération (Semi Authentic)",
      slug: "airpod-2",
      categorySlug: "ecouteurs",
      price: 8450,
      comparePrice: 11050,
      stock: 20,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 32,
      description:
        "Écouteurs intra-auriculaires semi-authentiques avec une excellente qualité sonore.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/1rwAVQ8na5y4gwHrKt4Su2P72ob9YWPRXsmKrPSN.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Type", value: "Intra-auriculaire" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.0" },
        { id: 3, label: "Autonomie", value: "Jusqu'à 5h" },
      ]),
    },
    {
      name: "AirPod 3ème génération",
      slug: "airpod-3",
      categorySlug: "ecouteurs",
      price: 9750,
      comparePrice: 16900,
      stock: 12,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 28,
      description:
        "Conception entièrement repensée. Audio spatial avec suivi dynamique de la tête. Résistant à la transpiration et à l'eau.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/qcVSC2fdDwuWjKV9VoRogKGcfZtKkWpNg6aB2xqX.webp",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Type", value: "Semi-intra-auriculaire" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.0" },
        { id: 3, label: "Résistance", value: "IPX4" },
        { id: 4, label: "Autonomie", value: "6h (30h avec boîtier)" },
      ]),
    },
    {
      name: "AirPod 4ème génération (Semi Authentic)",
      slug: "airpod-4",
      categorySlug: "ecouteurs",
      price: 9750,
      comparePrice: null,
      stock: 8,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 15,
      description:
        "Dernière génération AirPod avec réduction de bruit active et audio spatial.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/Vh1E5wolcR2kRWx9HvXoVLLMPd8UG1neURyCW9jD.webp",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Type", value: "Intra-auriculaire" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.3" },
        { id: 3, label: "Autonomie", value: "Jusqu'à 6h" },
      ]),
    },
    {
      name: "AirPod Pro 3ème génération (Semi Authentic)",
      slug: "airpod-pro-3",
      categorySlug: "ecouteurs",
      price: 34450,
      comparePrice: null,
      stock: 3,
      status: "Stock limité",
      featured: true,
      active: true,
      salesCount: 9,
      description:
        "AirPods Pro 3ème génération avec puce H3. Réduction de bruit encore plus avancée.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/eQ9ad20YUmJ6UUbl9Tm5o6uGXMuXBPlEouopPxcu.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puce", value: "Apple H3" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.4" },
        { id: 3, label: "Résistance", value: "IP54" },
        { id: 4, label: "Autonomie", value: "Jusqu'à 7h" },
      ]),
    },
    {
      name: "Samsung Buds 3 Pro",
      slug: "samsung-buds3-pro",
      categorySlug: "ecouteurs",
      price: 16900,
      comparePrice: 28600,
      stock: 7,
      status: "Stock limité",
      featured: true,
      active: true,
      salesCount: 21,
      description:
        "Réduction de bruit active intelligente. Son Hi-Fi 360 Audio. Design ergonomique avec embouts en silicone.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/9xdaF67Rkr3Re88cyWf13i1CAm0y27sFFXSVwsov.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Type", value: "Intra-auriculaire" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.3" },
        { id: 3, label: "Autonomie", value: "Jusqu'à 7h (30h avec boîtier)" },
        { id: 4, label: "Résistance", value: "IPX7" },
        { id: 5, label: "Compatibilité", value: "Android / iOS" },
      ]),
    },
    {
      name: "Samsung Buds 3",
      slug: "samsung-buds-3",
      categorySlug: "ecouteurs",
      price: 16900,
      comparePrice: 20800,
      stock: 10,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 18,
      description:
        "Écouteurs Samsung avec réduction de bruit active et son cristallin.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/6pRuYd8Oq2rpBLakSuOmtY9imxYIDdOKdLSXVAiY.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Connectivité", value: "Bluetooth 5.3" },
        { id: 2, label: "Résistance", value: "IPX5" },
        { id: 3, label: "Autonomie", value: "6h (26h avec boîtier)" },
      ]),
    },
    {
      name: "Bose QuietComfort Ultra",
      slug: "bose-quietcomfort-ultra",
      categorySlug: "ecouteurs",
      price: 13650,
      comparePrice: 20800,
      stock: 5,
      status: "En stock",
      featured: true,
      active: true,
      salesCount: 14,
      description:
        "La référence mondiale en matière de réduction de bruit active. Son Bose immersif.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/xItHwgVZDwyPhTHbeXRbHWfrL3CAOTtiHBfY3GEY.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Type", value: "Circum-auriculaire" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.3" },
        { id: 3, label: "Autonomie", value: "24h (avec ANC)" },
        { id: 4, label: "Poids", value: "254g" },
      ]),
    },
    {
      name: "JBL Boombox 4ème génération (Authentique)",
      slug: "jbl-boombox-4",
      categorySlug: "enceintes",
      price: 496100,
      comparePrice: null,
      stock: 4,
      status: "En stock",
      featured: true,
      active: true,
      salesCount: 6,
      description:
        "Son JBL Pro authentique avec basses puissantes. Autonomie 24h. Résistant à l'eau IP67.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/OqOWjiMzUmyZ1hgx5tdXO09sCupG1bIe3TQIQ4M8.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puissance", value: "60W RMS" },
        { id: 2, label: "Autonomie", value: "24 heures" },
        { id: 3, label: "Résistance", value: "IP67" },
        { id: 4, label: "Connectivité", value: "Bluetooth 5.3" },
        { id: 5, label: "Poids", value: "5.5 kg" },
      ]),
    },
    {
      name: "JBL Boombox 3 Wifi (Authentique)",
      slug: "jbl-boombox-3-wifi",
      categorySlug: "enceintes",
      price: 346450,
      comparePrice: null,
      stock: 3,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 4,
      description:
        "Enceinte JBL avec WiFi intégré. Compatible AirPlay 2 et Alexa.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/rYRLZGPF5T1ynh3MizOJcIUvMV2DUnJXp2OOfDfp.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puissance", value: "30W RMS" },
        { id: 2, label: "Connectivité", value: "Bluetooth 5.0 + WiFi" },
        { id: 3, label: "Résistance", value: "IP67" },
        { id: 4, label: "Autonomie", value: "24 heures" },
      ]),
    },
    {
      name: "JBL Boombox 2 (Authentique)",
      slug: "jbl-boombox-2",
      categorySlug: "enceintes",
      price: 265200,
      comparePrice: 288600,
      stock: 5,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 7,
      description:
        "Enceinte portable JBL Boombox 2 avec un son puissant et des basses profondes.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/vnOoF2BthZOlJ1RvOEZrRUTNNjRhdwkyHAecS85L.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puissance", value: "48W RMS" },
        { id: 2, label: "Autonomie", value: "24 heures" },
        { id: 3, label: "Résistance", value: "IPX7" },
        { id: 4, label: "Connectivité", value: "Bluetooth 5.0" },
      ]),
    },
    {
      name: "JBL Alaxe",
      slug: "jbl-alaxe",
      categorySlug: "enceintes",
      price: 10400,
      comparePrice: 16900,
      stock: 18,
      status: "En stock",
      featured: true,
      active: true,
      salesCount: 35,
      description:
        "Petite enceinte JBL compacte avec un son surprenant pour sa taille.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/qq9TGtxdRrXnO7Ur6V3Ud6vvc9esFGXNALDnM8lA.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puissance", value: "5W RMS" },
        { id: 2, label: "Autonomie", value: "8 heures" },
        { id: 3, label: "Résistance", value: "IPX7" },
        { id: 4, label: "Connectivité", value: "Bluetooth 5.0" },
      ]),
    },
    {
      name: "ELF Box 40000 Puffs",
      slug: "elf-box-40000",
      categorySlug: "vapes",
      price: 9750,
      comparePrice: 16900,
      stock: 3,
      status: "Stock limité",
      featured: true,
      active: true,
      salesCount: 22,
      description:
        "Vape jetable ELF Box avec 40 000 puffs. Saveurs variées disponibles.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/xhxmt8I9gvXd3cQhMmrvtqYr1F6fcqbNJc7iZnF2.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puffs", value: "40 000" },
        { id: 2, label: "Nicotine", value: "5% (50mg)" },
        { id: 3, label: "Batterie", value: "650mAh rechargeable" },
        { id: 4, label: "Contenance", value: "28ml" },
      ]),
    },
    {
      name: "ELF Box 14000 Puffs",
      slug: "elf-box-14000",
      categorySlug: "vapes",
      price: 9750,
      comparePrice: 16900,
      stock: 10,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 16,
      description:
        "Vape jetable ELF Box avec 14 000 puffs. Design compact et élégant.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/vCbPZ4WH3dXERCa77hrdVpqg7aVqo0dPIxd6HvvT.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puffs", value: "14 000" },
        { id: 2, label: "Nicotine", value: "5% (50mg)" },
        { id: 3, label: "Batterie", value: "500mAh rechargeable" },
        { id: 4, label: "Contenance", value: "12ml" },
      ]),
    },
    {
      name: "Cloud Bar 20 000 Puffs",
      slug: "cloud-bar-20000",
      categorySlug: "vapes",
      price: 7150,
      comparePrice: 9100,
      stock: 14,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 19,
      description:
        "Vape Cloud Bar 20 000 puffs avec une saveur intense et durable.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/RzxTcau920HE2Z0o5KBG4Uwn2tkq35PflUmD1K0N.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puffs", value: "20 000" },
        { id: 2, label: "Nicotine", value: "5% (50mg)" },
        { id: 3, label: "Batterie", value: "600mAh rechargeable" },
        { id: 4, label: "Contenance", value: "18ml" },
      ]),
    },
    {
      name: "Monster 28K Puffs",
      slug: "monster-28k",
      categorySlug: "vapes",
      price: 9750,
      comparePrice: 16900,
      stock: 2,
      status: "Stock limité",
      featured: true,
      active: true,
      salesCount: 11,
      description:
        "Vape Monster avec 28 000 puffs. Saveur intense et autonomie exceptionnelle.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/lFaBU2gVDjmf98x9o6kPugbLRSRutaxsY5aLfpxX.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Puffs", value: "28 000" },
        { id: 2, label: "Nicotine", value: "5% (50mg)" },
        { id: 3, label: "Batterie", value: "650mAh rechargeable" },
        { id: 4, label: "Contenance", value: "20ml" },
      ]),
    },
    {
      name: "Sextoy La Rose",
      slug: "sextoy-la-rose",
      categorySlug: "for-woman",
      price: 16900,
      comparePrice: 28600,
      stock: 8,
      status: "En stock",
      featured: true,
      active: true,
      salesCount: 13,
      description:
        "Stimulateur en forme de rose. Discret, rechargeable et waterproof.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/vMn0JkFhdYgdQjSh36ffh33D3jwu8c98RMS139Zvw.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Matière", value: "Silicone médical" },
        { id: 2, label: "Modes", value: "10 modes de vibration" },
        { id: 3, label: "Résistance", value: "Waterproof IPX6" },
        { id: 4, label: "Charge", value: "USB-C" },
      ]),
    },
    {
      name: "Sextoy 3 Oeuf Vibrant Connecté",
      slug: "sextoy-oeuf-vibrant",
      categorySlug: "for-woman",
      price: 9750,
      comparePrice: 19500,
      stock: 6,
      status: "En stock",
      featured: false,
      active: true,
      salesCount: 8,
      description:
        "Set de 3 œufs vibrants connectés via application. Contrôle à distance.",
      images: JSON.stringify([
        "https://cdn.youcan.shop/stores/eec70b1adf73605b6dc143303da984eb/products/mgNk4wJ54rKLDYBDsQOeu6GTSCtj2xiZ8esFpj9B.jpg",
      ]),
      specs: JSON.stringify([
        { id: 1, label: "Contenu", value: "3 œufs vibrants" },
        { id: 2, label: "Contrôle", value: "Application smartphone" },
        { id: 3, label: "Matière", value: "Silicone médical" },
        { id: 4, label: "Résistance", value: "Waterproof" },
      ]),
    },
  ];

  for (const product of productsData) {
    await prisma.product.upsert({
      where: { slug: product.slug },
      update: product,
      create: product,
    });
  }
  console.log(`✅ ${productsData.length} produits créés`);

  // ── 3. Services abonnements ───────────────────────────────────────────────
  console.log("🎬 Services abonnements...");
  const servicesData = [
    {
      slug: "netflix",
      name: "Netflix",
      tagline: "Films, séries et documentaires en illimité",
      category: "family",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "spotify",
      name: "Spotify",
      tagline: "Musique en streaming illimitée sans pub",
      category: "family",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "apple-music",
      name: "Apple Music",
      tagline: "100 millions de titres en qualité Lossless",
      category: "family",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "disney-plus",
      name: "Disney+",
      tagline: "Disney, Marvel, Star Wars, Pixar",
      category: "family",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "youtube-premium",
      name: "YouTube Premium",
      tagline: "YouTube sans pub, en arrière-plan",
      category: "family",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "canva",
      name: "Canva Pro",
      tagline: "Design professionnel pour tous",
      category: "link_access",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "chatgpt",
      name: "ChatGPT Plus",
      tagline: "GPT-4o, DALL·E 3 et plugins en illimité",
      category: "link_access",
      available: true,
      serviceStatus: "active",
    },
    {
      slug: "crunchyroll",
      name: "Crunchyroll",
      tagline: "Anime en streaming en illimité",
      category: "family",
      available: true,
      serviceStatus: "active",
    },
  ];

  const plansData = {
    netflix: [
      { label: "Standard 1 mois", duration: 1, price: 3500 },
      { label: "Premium 1 mois", duration: 1, price: 5500 },
      { label: "Premium 3 mois", duration: 3, price: 14500 },
      { label: "Premium 6 mois", duration: 6, price: 27000 },
    ],
    spotify: [
      { label: "Premium 1 mois", duration: 1, price: 2000 },
      { label: "Premium 3 mois", duration: 3, price: 5500 },
      { label: "Premium 6 mois", duration: 6, price: 10000 },
    ],
    "apple-music": [
      { label: "Individuel 1 mois", duration: 1, price: 2500 },
      { label: "Individuel 3 mois", duration: 3, price: 7000 },
    ],
    "disney-plus": [
      { label: "Standard 1 mois", duration: 1, price: 3000 },
      { label: "Premium 1 mois", duration: 1, price: 4500 },
    ],
    "youtube-premium": [
      { label: "Premium 1 mois", duration: 1, price: 2500 },
      { label: "Premium 3 mois", duration: 3, price: 7000 },
    ],
    canva: [
      { label: "Pro 1 mois", duration: 1, price: 4000 },
      { label: "Pro 3 mois", duration: 3, price: 11000 },
      { label: "Pro 12 mois", duration: 12, price: 35000 },
    ],
    chatgpt: [{ label: "Plus 1 mois", duration: 1, price: 8000 }],
    crunchyroll: [
      { label: "Mega Fan 1 mois", duration: 1, price: 2000 },
      { label: "Mega Fan 3 mois", duration: 3, price: 5500 },
    ],
  };

  for (const svc of servicesData) {
    const service = await prisma.subscriptionService.upsert({
      where: { slug: svc.slug },
      update: svc,
      create: svc,
    });

    const plans = plansData[svc.slug] || [];
    for (const plan of plans) {
      const existing = await prisma.subscriptionPlan.findFirst({
        where: { serviceId: service.id, label: plan.label },
      });
      if (!existing) {
        await prisma.subscriptionPlan.create({
          data: { ...plan, serviceId: service.id },
        });
      }
    }
  }
  console.log(`✅ ${servicesData.length} services + plans créés`);

  // ── 4. Coupons ────────────────────────────────────────────────────────────
  console.log("🏷️ Coupons...");
  const couponsData = [
    {
      code: "BIENVENUE10",
      type: "PERCENTAGE",
      value: 10,
      minOrder: 5000,
      maxUses: 100,
      usedCount: 0,
      expiresAt: new Date("2026-12-31"),
      active: true,
    },
    {
      code: "MTECH2000",
      type: "FIXED",
      value: 2000,
      minOrder: 10000,
      maxUses: 50,
      usedCount: 0,
      expiresAt: new Date("2026-09-30"),
      active: true,
    },
    {
      code: "NOEL5000",
      type: "FIXED",
      value: 5000,
      minOrder: 20000,
      maxUses: 30,
      usedCount: 0,
      expiresAt: new Date("2026-12-25"),
      active: true,
    },
  ];

  for (const coupon of couponsData) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: coupon,
      create: coupon,
    });
  }
  console.log(`✅ ${couponsData.length} coupons créés`);

  // ── 5. Zones de livraison ─────────────────────────────────────────────────
  console.log("🚚 Zones de livraison...");
  const zonesData = [
    { name: "Cotonou", fee: 1000, delay: "2-4h", active: true },
    { name: "Abomey-Calavi", fee: 1500, delay: "3-6h", active: true },
    { name: "Porto-Novo", fee: 2000, delay: "24h", active: true },
    { name: "Parakou", fee: 5000, delay: "48h", active: false },
  ];

  for (const zone of zonesData) {
    await prisma.deliveryZone.upsert({
      where: { name: zone.name },
      update: zone,
      create: zone,
    });
  }
  console.log(`✅ ${zonesData.length} zones créées`);

  // ── 6. Paramètres boutique ────────────────────────────────────────────────
  console.log("⚙️ Paramètres...");
  const settingsData = [
    { key: "shopName", value: "MTECHBENIN" },
    {
      key: "shopSlogan",
      value:
        "Votre boutique tech de confiance au Bénin. Livraison express à Cotonou.",
    },
    { key: "shopEmail", value: "contact@mtechbenin.com" },
    { key: "shopWhatsapp", value: "+229 61 15 15 61" },
    { key: "shopAddress", value: "Cotonou, Bénin" },
    { key: "shopFacebook", value: "https://facebook.com/mtechbenin" },
    { key: "shopInstagram", value: "https://instagram.com/mtechbenin" },
    { key: "shopTiktok", value: "https://tiktok.com/@mtechbenin" },
    { key: "fedapayEnv", value: "live" },
    { key: "paymentFeePercent", value: "2.9" },
    { key: "maintenanceMode", value: "false" },
    {
      key: "maintenanceMessage",
      value: "Site en maintenance. Nous revenons très bientôt !",
    },
    // Frais d'enlèvement du service de réparation, en FCFA entiers. 0 =
    // enlèvement gratuit, aucun paiement n'est demandé au client (voir
    // `lireFraisEnlevement`, repairs.controller.js). Sans cette ligne, la clé
    // est absente en base au premier déploiement et le comportement est
    // identique (0 par défaut) mais silencieux — on préfère l'écrire.
    { key: "fraisEnlevementReparation", value: "0" },
    { key: "adminPassword", value: "admin2026" },
  ];

  for (const setting of settingsData) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: { value: setting.value },
      create: setting,
    });
  }
  console.log(`✅ ${settingsData.length} paramètres créés`);

  // ── 7. Hero slides ────────────────────────────────────────────────────────
  console.log("🎠 Hero slides...");
  const heroCount = await prisma.heroMedia.count();
  if (heroCount === 0) {
    const heroData = [
      {
        type: "gradient",
        active: true,
        order: 1,
        tag: "Nouveauté",
        title: "AirPods Pro",
        subtitle: "2ème Génération",
        description:
          "Audio spatial personnalisé. Réduction de bruit active. Livraison express à Cotonou.",
        cta: "Découvrir",
        href: "/catalogue/ecouteurs",
        badge: "À partir de 9 750 FCFA",
        bg: "from-[#0A0A0A] via-[#1a1a2e] to-[#0f3460]",
        categoryKey: "ecouteurs",
      },
      {
        type: "gradient",
        active: true,
        order: 2,
        tag: "Best Seller",
        title: "JBL Boombox",
        subtitle: "4ème Génération",
        description:
          "Son puissant, basses profondes. La référence des enceintes Bluetooth au Bénin.",
        cta: "Voir les enceintes",
        href: "/catalogue/enceintes",
        badge: "Authentique & Garanti",
        bg: "from-[#0f0f0f] via-[#1a1a1a] to-[#2d2d2d]",
        categoryKey: "enceintes",
      },
      {
        type: "gradient",
        active: true,
        order: 3,
        tag: "Digital",
        title: "Abonnements",
        subtitle: "Netflix · Spotify · Apple Music",
        description:
          "Accédez à vos plateformes préférées au meilleur prix. Activation en quelques minutes.",
        cta: "Voir les abonnements",
        href: "/abonnements",
        badge: "Dès 3 000 FCFA/mois",
        bg: "from-[#0a0a2e] via-[#0f1a3d] to-[#1D72B8]",
        categoryKey: "abonnements",
      },
    ];
    await prisma.heroMedia.createMany({ data: heroData });
    console.log(`✅ ${heroData.length} hero slides créés`);
  } else {
    console.log(`⏭️ Hero slides déjà présents (${heroCount}), skipped`);
  }

  // ── 8. Avis featured ─────────────────────────────────────────────────────
  console.log("⭐ Avis...");
  const reviewsCount = await prisma.review.count();
  if (reviewsCount === 0) {
    const reviewsData = [
      {
        productSlug: "airpod-pro-2",
        productName: "AirPod Pro 2ème génération",
        name: "Koffi Mensah",
        city: "Cotonou",
        rating: 5,
        text: "Livraison ultra rapide ! J'ai reçu mes AirPods Pro en moins de 2h. Qualité au rendez-vous, je recommande vivement MTECHBENIN.",
        date: "Mai 2026",
        approved: true,
        featured: true,
      },
      {
        productSlug: "jbl-alaxe",
        productName: "JBL Alaxe",
        name: "Aïcha Dossou",
        city: "Abomey-Calavi",
        rating: 5,
        text: "Son excellent pour le prix, livraison rapide. Très satisfaite de mon achat chez MTECHBENIN !",
        date: "Mai 2026",
        approved: true,
        featured: true,
      },
      {
        productSlug: "jbl-boombox-4",
        productName: "JBL Boombox 4ème génération",
        name: "Rodrigue Agossou",
        city: "Cotonou",
        rating: 5,
        text: "La JBL Boombox est authentique, son incroyable. Le vendeur est très réactif sur WhatsApp. Je suis client fidèle.",
        date: "Avril 2026",
        approved: true,
        featured: true,
      },
      {
        productSlug: "airpod-pro-2",
        productName: "AirPod Pro 2ème génération",
        name: "Fatouma Traoré",
        city: "Porto-Novo",
        rating: 4,
        text: "Très bonne qualité, conforme à la description. Service client réactif via WhatsApp.",
        date: "Avril 2026",
        approved: true,
        featured: false,
      },
      {
        productSlug: "elf-box-40000",
        productName: "ELF Box 40000 Puffs",
        name: "Kevin Mensah",
        city: "Cotonou",
        rating: 5,
        text: "Produit de qualité, livraison express. Je recommande !",
        date: "Mars 2026",
        approved: true,
        featured: false,
      },
    ];
    await prisma.review.createMany({ data: reviewsData });
    console.log(`✅ ${reviewsData.length} avis créés`);
  } else {
    console.log(`⏭️ Avis déjà présents (${reviewsCount}), skipped`);
  }

  // ── 9. FAQ par défaut ─────────────────────────────────────────────────────
  console.log("❓ FAQ...");
  const faqCount = await prisma.faq.count();
  if (faqCount === 0) {
    const faqData = [
      { category: "Commandes", orderIndex: 0, isPublished: true, question: "Comment passer une commande ?", answer: "Ajoutez vos produits au panier, puis cliquez sur 'Commander'. Renseignez votre nom, WhatsApp et adresse GPS, choisissez votre créneau et payez via FedaPay (MTN MoMo, Moov Money, Celtiis, Visa/MasterCard). Vous recevrez une confirmation instantanée sur WhatsApp." },
      { category: "Commandes", orderIndex: 1, isPublished: true, question: "Comment suivre ma commande ?", answer: "Après paiement, vous recevez un numéro de commande (MTECH-2026-XXXXX). Rendez-vous sur mtechbenin.com/suivi et entrez ce numéro pour voir l'état en temps réel." },
      { category: "Commandes", orderIndex: 2, isPublished: true, question: "Puis-je modifier ou annuler ma commande ?", answer: "Vous pouvez annuler ou modifier votre commande dans les 30 minutes suivant le paiement en contactant notre équipe sur WhatsApp. Passé ce délai, la commande est déjà en préparation." },
      { category: "Paiement", orderIndex: 3, isPublished: true, question: "Quels modes de paiement acceptez-vous ?", answer: "Nous acceptons MTN Mobile Money, Moov Money, Celtiis, BMO, Coris Money et Visa/MasterCard. Tous les paiements sont sécurisés via la plateforme FedaPay." },
      { category: "Paiement", orderIndex: 4, isPublished: true, question: "Le paiement est-il sécurisé ?", answer: "Oui, tous les paiements sont traités par FedaPay, une plateforme certifiée et sécurisée. Nous ne stockons jamais vos informations bancaires ou de Mobile Money." },
      { category: "Livraison", orderIndex: 5, isPublished: true, question: "Dans quelles villes livrez-vous ?", answer: "Nous livrons à Cotonou (1 000 FCFA, 2-4h), Abomey-Calavi (1 500 FCFA, 3-6h), Porto-Novo (2 000 FCFA, 24h) et d'autres villes sur devis." },
      { category: "Abonnements Digitaux", orderIndex: 6, isPublished: true, question: "Comment reçois-je mes identifiants après achat ?", answer: "Après confirmation du paiement, vous recevez automatiquement vos identifiants (email, mot de passe, profil) par WhatsApp et email en moins de 5 minutes." },
      { category: "Abonnements Digitaux", orderIndex: 7, isPublished: true, question: "Que se passe-t-il si Netflix envoie un code de vérification ?", answer: "Vous devez d'abord nous le demander : écrivez « CODE » sur notre WhatsApp, ou saisissez votre numéro sur la page « Demander mon code » du site. Nous transmettons alors sur votre WhatsApp le prochain code reçu pour votre abonnement. Une demande reste valable 15 minutes ; si vous ne recevez rien, refaites-en une." },
      { category: "Retours", orderIndex: 8, isPublished: true, question: "Quelle est votre politique de retour ?", answer: "Vous disposez de 7 jours après réception pour demander un retour. Le produit doit être non utilisé et dans son emballage d'origine. Contactez-nous sur WhatsApp avant tout renvoi." },
    ];
    await prisma.faq.createMany({ data: faqData });
    console.log(`✅ ${faqData.length} FAQs créées`);
  } else {
    console.log(`⏭️ FAQs déjà présentes (${faqCount}), skipped`);
  }

  // ── 10. Pages légales par défaut ──────────────────────────────────────────
  console.log("📄 Pages légales...");
  const legalDefaults = [
    { slug: "politique-confidentialite", title: "Politique de Confidentialité", content: "<h2>Collecte des données</h2><p>MTECHBENIN collecte uniquement les données nécessaires au traitement de vos commandes : nom, numéro WhatsApp, adresse de livraison et adresse e-mail optionnelle.</p><h2>Utilisation des données</h2><p>Vos données sont utilisées exclusivement pour le traitement et le suivi de vos commandes. Elles ne sont jamais vendues ou partagées avec des tiers à des fins commerciales.</p><h2>Conservation</h2><p>Vos données sont conservées 3 ans à compter du dernier achat, conformément à la réglementation en vigueur au Bénin.</p><h2>Vos droits</h2><p>Vous pouvez demander la suppression ou la rectification de vos données à tout moment en nous contactant via WhatsApp ou par e-mail.</p>" },
    { slug: "cgv", title: "Conditions Générales de Vente", content: "<h2>Objet</h2><p>Les présentes Conditions Générales de Vente régissent les ventes réalisées sur le site mtechbenin.com.</p><h2>Commandes</h2><p>Toute commande implique l'acceptation des présentes CGV. La commande est validée à réception du paiement.</p><h2>Prix</h2><p>Les prix sont indiqués en Francs CFA (FCFA) toutes taxes comprises. MTECHBENIN se réserve le droit de modifier ses prix à tout moment.</p><h2>Paiement</h2><p>Le paiement s'effectue en ligne via FedaPay (MTN MoMo, Moov Money, Celtiis, Visa/MasterCard). La commande n'est confirmée qu'après validation du paiement.</p><h2>Livraison</h2><p>Les délais et frais de livraison varient selon la zone. Voir notre page Livraison pour les détails.</p>" },
    { slug: "politique-cookies", title: "Politique des Cookies", content: "<h2>Qu'est-ce qu'un cookie ?</h2><p>Un cookie est un petit fichier texte déposé sur votre appareil lors de la visite d'un site web.</p><h2>Cookies utilisés</h2><p>Nous utilisons uniquement des cookies techniques essentiels au bon fonctionnement du site (panier, session). Aucun cookie publicitaire ou de tracking n'est utilisé.</p><h2>Durée de conservation</h2><p>Les cookies de session expirent à la fermeture de votre navigateur. Le cookie de panier est conservé 7 jours.</p><h2>Désactivation</h2><p>Vous pouvez désactiver les cookies dans les paramètres de votre navigateur, mais cela peut affecter le fonctionnement du site.</p>" },
    { slug: "retours", title: "Retours & Échanges", content: "<h2>Délai de retour</h2><p>Vous disposez de 7 jours calendaires à compter de la réception pour demander un retour ou un échange.</p><h2>Conditions</h2><p>Le produit doit être non utilisé, dans son emballage d'origine et accompagné de la preuve d'achat. Les produits endommagés par une mauvaise utilisation ne sont pas éligibles au retour.</p><h2>Procédure</h2><p>Contactez-nous via WhatsApp avant tout renvoi. Nous vous communiquerons l'adresse de retour et les modalités.</p><h2>Remboursement</h2><p>Le remboursement est effectué sur votre compte Mobile Money sous 5 jours ouvrés après réception et vérification du produit retourné.</p>" },
    { slug: "livraison", title: "Livraison", content: "<h2>Zones et délais</h2><p>Cotonou : 1 000 FCFA — 2 à 4 heures</p><p>Abomey-Calavi : 1 500 FCFA — 3 à 6 heures</p><p>Porto-Novo : 2 000 FCFA — 24 heures</p><p>Autres villes : sur devis — contactez-nous via WhatsApp</p><h2>Créneaux de livraison</h2><p>Vous choisissez votre créneau lors de la commande : matin (8h-12h), après-midi (12h-17h) ou soir (17h-20h).</p><h2>Suivi</h2><p>Un livreur vous contacte sur WhatsApp avant le passage. Vous pouvez suivre votre commande en temps réel sur mtechbenin.com/suivi.</p><h2>Livraison gratuite</h2><p>La livraison est offerte à Cotonou pour toute commande supérieure à 30 000 FCFA.</p>" },
  ];
  for (const page of legalDefaults) {
    await prisma.legalPage.upsert({
      where: { slug: page.slug },
      update: {},
      create: page,
    });
  }
  console.log(`✅ ${legalDefaults.length} pages légales initialisées`);

  console.log("\n🎉 Seed terminé avec succès !");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`📦 Produits   : ${productsData.length}`);
  console.log(`📁 Catégories : ${categoriesData.length}`);
  console.log(`🎬 Services   : ${servicesData.length}`);
  console.log(`🏷️  Coupons    : ${couponsData.length}`);
  console.log(`🚚 Zones      : ${zonesData.length}`);
  console.log(`⚙️  Paramètres : ${settingsData.length}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main()
  .catch((e) => {
    console.error("❌ Erreur seed :", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
