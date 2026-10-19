const test = require("node:test");
const assert = require("node:assert");

const { renderAdminLinkIncident } = require("./index");

// Ce gabarit est le DERNIER recours quand un lien a été retiré de la réserve
// sans qu'aucune ligne cliente n'ait pu être écrite : à ce moment-là, l'URL
// n'existe plus que dans le journal du serveur et dans cet e-mail. S'il perd
// l'URL, le client a payé pour un accès que plus personne ne peut lui envoyer.
test("alerte admin — lien consommé sans trace", async (t) => {
  await t.test("porte l'URL du lien, en clair et copiable", () => {
    const url = "https://setup.icloud.com/family/messages?inviteCode=ABC_123";
    const html = renderAdminLinkIncident({
      serviceName: "Spotify",
      clientName: "Aline",
      clientWhatsapp: "+22997000000",
      link: url,
    });
    // L'URL contient une esperluette une fois échappée : on vérifie donc les
    // deux formes possibles plutôt que la chaîne brute.
    assert.ok(html.includes(url) || html.includes(url.replace(/&/g, "&amp;")));
  });

  await t.test("porte le service et le client", () => {
    const html = renderAdminLinkIncident({
      serviceName: "Canva Pro",
      clientName: "Koffi",
      clientWhatsapp: "+22997000001",
      link: "https://example.com/a",
    });
    assert.ok(html.includes("Canva Pro"));
    assert.ok(html.includes("Koffi"));
    assert.ok(html.includes("+22997000001"));
  });

  await t.test("est rédigée en français", () => {
    const html = renderAdminLinkIncident({
      serviceName: "Spotify",
      clientName: "Aline",
      clientWhatsapp: "+229",
      link: "https://example.com/a",
    });
    assert.ok(html.includes("Lien consommé sans trace"));
    assert.ok(html.includes("Service"));
    assert.ok(html.includes('lang="fr"'));
  });

  // Un nom de client vient de la commande, donc du client lui-même : il ne doit
  // jamais pouvoir injecter de balise dans la boîte de l'administrateur.
  await t.test("échappe le HTML des valeurs reçues", () => {
    const html = renderAdminLinkIncident({
      serviceName: "Spotify",
      clientName: '<script>alert("x")</script>',
      clientWhatsapp: "+229",
      link: "https://example.com/a",
    });
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  // Le WhatsApp peut manquer (ligne créée à la main sans numéro) : le gabarit
  // doit rendre quand même, sans « undefined » visible.
  await t.test("rend sans numéro WhatsApp, sans afficher undefined", () => {
    const html = renderAdminLinkIncident({
      serviceName: "Spotify",
      clientName: "Aline",
      clientWhatsapp: null,
      link: "https://example.com/a",
    });
    assert.ok(!html.includes("undefined"));
    assert.ok(html.includes("Aline"));
  });
});
