const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

const DEFAULT_FAQS = [
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

// ── Public ────────────────────────────────────────────────────────────────────
async function getPublishedFaqs(req, res) {
  try {
    const faqs = await prisma.faq.findMany({
      where: { isPublished: true },
      orderBy: [{ category: "asc" }, { orderIndex: "asc" }],
    });
    return res.json({ faqs });
  } catch (err) {
    logger.error("Erreur getPublishedFaqs", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────
async function getAllFaqs(req, res) {
  try {
    const count = await prisma.faq.count();
    if (count === 0) {
      await prisma.faq.createMany({ data: DEFAULT_FAQS });
    }
    const faqs = await prisma.faq.findMany({
      orderBy: [{ category: "asc" }, { orderIndex: "asc" }],
    });
    return res.json({ faqs });
  } catch (err) {
    logger.error("Erreur getAllFaqs", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createFaq(req, res) {
  try {
    const { category, question, answer, isPublished } = req.body;
    if (!question || !answer)
      return res.status(400).json({ error: "Question et réponse requises" });

    const maxOrder = await prisma.faq.aggregate({ _max: { orderIndex: true } });
    const faq = await prisma.faq.create({
      data: {
        category: category?.trim() || "Général",
        question: question.trim(),
        answer: answer.trim(),
        orderIndex: (maxOrder._max.orderIndex ?? -1) + 1,
        isPublished: isPublished !== false,
      },
    });
    return res.status(201).json({ faq });
  } catch (err) {
    logger.error("Erreur createFaq", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function updateFaq(req, res) {
  try {
    const { category, question, answer, isPublished } = req.body;
    const faq = await prisma.faq.update({
      where: { id: req.params.id },
      data: {
        ...(category !== undefined && { category: category.trim() }),
        ...(question !== undefined && { question: question.trim() }),
        ...(answer !== undefined && { answer: answer.trim() }),
        ...(isPublished !== undefined && { isPublished }),
      },
    });
    return res.json({ faq });
  } catch (err) {
    logger.error("Erreur updateFaq", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteFaq(req, res) {
  try {
    await prisma.faq.delete({ where: { id: req.params.id } });
    return res.json({ message: "FAQ supprimée" });
  } catch (err) {
    logger.error("Erreur deleteFaq", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Reçoit un tableau ordonné d'IDs et réassigne orderIndex
async function reorderFaqs(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids requis" });

    await Promise.all(
      ids.map((id, index) =>
        prisma.faq.update({ where: { id }, data: { orderIndex: index } })
      )
    );
    return res.json({ message: "Ordre mis à jour" });
  } catch (err) {
    logger.error("Erreur reorderFaqs", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

module.exports = { getPublishedFaqs, getAllFaqs, createFaq, updateFaq, deleteFaq, reorderFaqs };
