# Release note : Copilot IA, branche `develop-IA` (au 13/11/2026)

- Un chat dans le site, propulsé par Claude Haiku 5.5. Il reconnaît la vitrine, l'espace client et l'admin, et ne propose que ce que la personne a le droit de faire.
- Cinq spécialistes :
  - **Réservation** : trouve un créneau et ouvre le tunnel déjà filtré ; une heure demandée (« vers 16 h ») garde la bonne plage ;
  - **Rendez-vous** : reporter, annuler, marquer honoré ou absent, poser un rendez-vous pour une cliente ;
  - **Guide** : explique le site, emmène sur la bonne page, ouvre la fiche d'une prestation ou d'un praticien, et pré-remplit le formulaire d'inscription ou de connexion avec ce que la personne a dit (jamais le mot de passe, jamais la validation) ;
  - **Encaissement et reporting** : dit ce qui reste à encaisser et donne les chiffres d'une période ;
  - **Clients** : retrouve une fiche cliente.
- **Dans le tableau de bord et le back-office :**
  - le chat s'ouvre en panneau latéral, adapté au rôle (gérance ou praticien) ;
  - il guide vers les écrans auxquels votre rôle donne accès ;
  - il lit les filtres de la page affichée et en tient compte dans ses réponses ;
  - il pose lui-même les filtres en ouvrant un écran : planning (vue, date), encaissement (date, rendez-vous), reporting (période, dates de début et de fin), clients (recherche, fiche) ; il ouvre aussi les fiches du catalogue et du personnel ;
  - il fait le résumé de la journée (rendez-vous, statuts, montant encaissé, absences), avec les mêmes calculs que les écrans.
- **L'écran s'anime** : un curseur fantôme montre le lien visé avant que le chat navigue, et les créneaux et praticiens filtrés entrent en fondu. Rien ne bouge si le système demande moins de mouvement.
- Toute modification passe par une carte de confirmation et ne s'exécute qu'après votre clic, avec revérification des droits au moment du clic. Le chat n'encaisse jamais.
- Garde-fous : quotas, historique de 30 min, données minimisées, mention claire qu'il s'agit d'une IA. La partie fixe du prompt et le catalogue sont mis en cache pour réduire le coût.

## Mesuré contre le vrai modèle

- **Évaluation** (24 cas) : Haiku 24/24 en 3,4 s médian, Sonnet 22/22 en 4,9 s. On garde Haiku partout.
- **Injection de prompt** (12 cas, données piégées et demandes directes) : tenue à 100 % sur Haiku et Sonnet.
- Réservation : 5,7 s au lieu de 8,3 s ; ouverture d'une fiche : 1,5 s.
- Détail dans [evaluation.md](evaluation.md).

## Sécurité et conformité

- Tests de fuite entre salons et d'élévation de rôle sur chaque action.
- Les données lues ne peuvent plus refermer les balises qui les encadrent ; le contexte envoyé par la page est borné.
- Télémétrie de CopilotKit coupée partout.
- Registre des traitements : assistant conversationnel au §2.7, Anthropic sous-traitant au §5.

## Reste à faire

1. **Pousser la pile rebasée** sur `develop-IA` (autorisation de force-push à donner), puis ouvrir et fusionner les PR.
2. Relire et fusionner la PR #1478 (Terraform du secret de la clé).
3. **Décisions produit** :
   - activation salon par salon (P5-05) ;
   - laisser ou non la gérance annuler ou reporter un rendez-vous depuis le chat (aujourd'hui, seule la cliente le peut) ;
   - destination de la télémétrie OpenTelemetry (#1480).
4. Avant la mise en production : accord de sous-traitance avec Anthropic, mécanisme de transfert, mention dans la politique de données.
5. Test réel complet dans le site et le back-office avec l'API et la base lancées, puis fusion de `develop-IA` dans `develop`.
