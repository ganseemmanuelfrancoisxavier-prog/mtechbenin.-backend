// Import uniquement le catalogue; ne touche ni aux paramètres ni au compte admin.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  if (process.env.CONFIRM_CATALOG_SEED !== "YES") {
    throw new Error("Définir CONFIRM_CATALOG_SEED=YES pour confirmer l'import du catalogue.");
  }

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
      update: {},
      create: cat,
    });
  }

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

  let created = 0;
  for (const product of productsData) {
    const existing = await prisma.product.findUnique({
      where: { slug: product.slug },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.product.create({ data: product });
    created++;
  }
  console.log(`Catalogue prêt: ${created} nouveaux produits ajoutés sur ${productsData.length}.`);
}

main()
  .catch((error) => {
    console.error("Échec de l'import du catalogue:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
