#!/usr/bin/env python3
"""Tests de la barrière de merge — `scripts/pr_gate.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Pourquoi ces fonctions et pas d'autres : les deux tours de revue de la PR #121
ont trouvé, dans la seule fonction `sensitive()`, six manières distinctes de
laisser passer une PR qu'un humain aurait dû relire — labels cherchés sur la PR
au lieu de l'issue qu'elle referme, `gh` en échec ignoré, mots-clés de fermeture
incomplets, liste de fichiers tronquée à une centaine d'entrées, refus posé
après un retour anticipé, drapeau de contournement. Toutes ont été corrigées, et
toutes vérifiées à la main.

Une régression sur l'une d'elles ne casserait rien de visible : elle remergerait
des PR de paiement ou d'infrastructure sur `develop` sans que personne ne le
remarque. C'est le mode de défaillance que #111 dénonçait — un garde-fou qui ne
se déclenche pas. D'où ce harnais, ouvert en #122.

Aucune dépendance : `unittest` de la bibliothèque standard. Le dépôt n'a pas de
gestion de paquets Python, et la CI n'a ainsi qu'un interpréteur à poser.
"""
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pr_gate  # noqa: E402 — l'insertion de chemin ci-dessus doit la précéder


def completed(returncode=0, stdout="", stderr=""):
    """Une réponse de sous-processus, telle que `pr_gate.run` en rend."""
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class FakeGh:
    """Double de `pr_gate.run`, qui répond selon la commande et retient les appels.

    `run` est l'unique point par lequel la barrière parle à `gh` et à `git`. Le
    remplacer suffit à jouer n'importe quelle réponse — l'échec en particulier,
    qui est le cas que ces tests surveillent le plus : c'est en ne sachant pas
    que le garde-fou devient muet.

    Une commande qu'aucune règle ne couvre lève : un appel réseau inattendu doit
    faire rougir le test, pas partir vers GitHub.
    """

    def __init__(self, rules):
        self.rules = rules      # [(fragment attendu dans la commande, réponse)]
        self.calls = []

    def __call__(self, args, cwd=None, timeout=120):
        args = list(args)
        self.calls.append(args)
        joined = " ".join(args)
        for needle, result in self.rules:
            if needle in joined:
                return result
        raise AssertionError("commande non prévue par le test : " + joined)


def pr_stub(body="", labels=()):
    """La forme minimale d'une PR telle que `gh pr view --json` la rend."""
    return {"body": body, "labels": [{"name": name} for name in labels]}


class TestUnattended(unittest.TestCase):
    """`unattended()` — vrai quand personne ne peut répondre à un arbitrage."""

    FAUX = ["", "0", "false", "no", "False", "NO", "  false  "]
    VRAI = ["1", "true", "yes", "TRUE", "Yes", "  1  "]

    def test_valeurs_fausses(self):
        for value in self.FAUX:
            with self.subTest(value=value), mock.patch.dict(
                    os.environ, {pr_gate.UNATTENDED_ENV: value}):
                self.assertFalse(pr_gate.unattended())

    def test_valeurs_vraies(self):
        for value in self.VRAI:
            with self.subTest(value=value), mock.patch.dict(
                    os.environ, {pr_gate.UNATTENDED_ENV: value}):
                self.assertTrue(pr_gate.unattended())

    def test_variable_absente(self):
        with mock.patch.dict(os.environ, clear=True):
            self.assertFalse(pr_gate.unattended())

    def test_valeur_inconnue_vaut_vrai(self):
        # Fail-closed : un drapeau mal orthographié doit rendre la barrière plus
        # stricte, jamais plus permissive.
        with mock.patch.dict(os.environ, {pr_gate.UNATTENDED_ENV: "peut-être"}):
            self.assertTrue(pr_gate.unattended())


class TestClosesKeywords(unittest.TestCase):
    """`CLOSES` — les mots-clés qui relient une PR à l'issue dont on lit les labels.

    N'en reconnaître que trois laissait « Fixed #42 » — pourtant fermant pour
    GitHub — sans aucune lecture de labels, donc sans garde-fou.
    """

    NEUF = ["close", "closes", "closed", "fix", "fixes", "fixed",
            "resolve", "resolves", "resolved"]

    def test_les_neuf_mots_fermants(self):
        for word in self.NEUF:
            with self.subTest(mot=word):
                self.assertEqual(pr_gate.CLOSES.findall(word + " #42"), ["42"])

    def test_insensible_a_la_casse(self):
        for body in ["FIXES #7", "Closed #7", "ReSoLvEs #7"]:
            with self.subTest(corps=body):
                self.assertEqual(pr_gate.CLOSES.findall(body), ["7"])

    def test_mots_non_fermants(self):
        for body in ["Refs #42", "See #42", "Related to #42", "cf #42",
                     "Suite de #42", "Constat de revue de #42"]:
            with self.subTest(corps=body):
                self.assertEqual(pr_gate.CLOSES.findall(body), [])

    def test_faux_amis_lexicaux(self):
        # Un mot-clé enchâssé dans un autre mot ne ferme rien.
        for body in ["closest #42", "unclosed #42", "prefixes #42", "suffix #42"]:
            with self.subTest(corps=body):
                self.assertEqual(pr_gate.CLOSES.findall(body), [])

    def test_plusieurs_issues_dans_un_corps(self):
        body = "Closes #12\n\nCorrige aussi le cas de #99 — fixes #34, resolves #56."
        self.assertEqual(sorted(pr_gate.CLOSES.findall(body)), ["12", "34", "56"])


class TestIssueLabels(unittest.TestCase):
    """`issue_labels()` — les labels vivent sur l'issue, pas sur la PR.

    `/ticket` ouvre ses PR sans `--label` et `tracking.py` n'étiquette que des
    issues : chercher `mod:payments` et `security` sur la PR seule laissait ces
    deux périmètres sans garde-fou.
    """

    def test_labels_lus_sur_l_issue_refermee(self):
        fake = FakeGh([("issue view 42", completed(stdout="mod:payments\nP1\n"))])
        with mock.patch.object(pr_gate, "run", fake):
            labels = pr_gate.issue_labels(pr_stub(body="Closes #42"))
        self.assertEqual(labels, {"mod:payments", "P1"})
        self.assertEqual(fake.calls[0][:4], ["gh", "issue", "view", "42"])

    def test_gh_en_echec_rend_none(self):
        # Ne pas savoir vaut refus : un `gh` en limite de débit rendrait sinon le
        # garde-fou muet précisément quand la charge est forte.
        fake = FakeGh([("issue view 42",
                        completed(returncode=1, stderr="API rate limit exceeded"))])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertIsNone(pr_gate.issue_labels(pr_stub(body="Closes #42")))

    def test_un_echec_parmi_plusieurs_suffit(self):
        fake = FakeGh([("issue view 12", completed(stdout="security\n")),
                       ("issue view 34", completed(returncode=1, stderr="boom"))])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertIsNone(pr_gate.issue_labels(pr_stub(body="Closes #12, fixes #34")))

    def test_union_de_plusieurs_issues(self):
        fake = FakeGh([("issue view 12", completed(stdout="security\n")),
                       ("issue view 34", completed(stdout="mod:infra\nP2\n"))])
        with mock.patch.object(pr_gate, "run", fake):
            labels = pr_gate.issue_labels(pr_stub(body="Closes #12, fixes #34"))
        self.assertEqual(labels, {"security", "mod:infra", "P2"})

    def test_aucun_mot_fermant_aucun_appel_reseau(self):
        fake = FakeGh([])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertEqual(pr_gate.issue_labels(pr_stub(body="Refs #42")), set())
        self.assertEqual(fake.calls, [])

    def test_corps_absent(self):
        with mock.patch.object(pr_gate, "run", FakeGh([])):
            self.assertEqual(pr_gate.issue_labels({}), set())


class TestChangedPaths(unittest.TestCase):
    """`changed_paths()` — les fichiers de la PR, pagination comprise."""

    def test_liste_normalisee(self):
        fake = FakeGh([("pulls/7/files",
                        completed(stdout="a.ts\n\n  infra/terraform/main.tf  \n"))])
        with mock.patch.object(pr_gate, "run", fake):
            paths = pr_gate.changed_paths(7)
        self.assertEqual(paths, ["a.ts", "infra/terraform/main.tf"])

    def test_appel_pagine(self):
        # `--json files` s'arrêtait à une centaine d'entrées : le fichier sensible
        # d'une grosse PR y passait inaperçu.
        fake = FakeGh([("pulls/7/files", completed(stdout=""))])
        with mock.patch.object(pr_gate, "run", fake):
            pr_gate.changed_paths(7)
        command = " ".join(fake.calls[0])
        self.assertIn("--paginate", command)
        self.assertIn("per_page=100", command)

    def test_echec_rend_none(self):
        fake = FakeGh([("pulls/7/files", completed(returncode=1, stderr="boom"))])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertIsNone(pr_gate.changed_paths(7))


class TestSensitive(unittest.TestCase):
    """`sensitive()` — ce qui, dans une PR, appelle une relecture humaine."""

    def reasons(self, pr, paths, from_issue=frozenset()):
        """`sensitive()` avec la lecture des labels d'issue jouée d'avance.

        Elle a ses propres tests ci-dessus ; la neutraliser ici garde chaque cas
        sur un seul sujet.
        """
        with mock.patch.object(pr_gate, "issue_labels", return_value=from_issue):
            return pr_gate.sensitive(pr, paths)

    # --- chaque périmètre, isolément -------------------------------------

    def test_label_mod_payments(self):
        self.assertEqual(self.reasons(pr_stub(), [], {"mod:payments"}),
                         ["label mod:payments"])

    def test_label_security(self):
        self.assertEqual(self.reasons(pr_stub(), [], {"security"}),
                         ["label security"])

    def test_label_porte_par_la_pr_elle_meme(self):
        # Nos PR n'en portent pas, mais un humain peut en poser un à la main.
        self.assertEqual(self.reasons(pr_stub(labels=["security"]), []),
                         ["label security"])

    def test_label_anodin_ignore(self):
        self.assertEqual(self.reasons(pr_stub(), [], {"P0", "ws:devops", "mod:infra"}), [])

    def test_terraform(self):
        self.assertEqual(self.reasons(pr_stub(), ["infra/terraform/dev/main.tf"]),
                         ["infra/terraform"])

    def test_module_payments(self):
        self.assertEqual(
            self.reasons(pr_stub(), ["apps/api/src/modules/payments/refund.service.ts"]),
            ["apps/api/src/modules/payments"])

    def test_schema_prisma(self):
        self.assertEqual(self.reasons(pr_stub(), ["apps/api/prisma/schema.prisma"]),
                         ["schéma ou migration Prisma"])

    def test_migration_prisma(self):
        self.assertEqual(
            self.reasons(pr_stub(),
                         ["apps/api/prisma/migrations/20260101_init/migration.sql"]),
            ["schéma ou migration Prisma"])

    def test_prisma_a_la_racine(self):
        for path in ["prisma/schema.prisma", "prisma/migrations/001/migration.sql"]:
            with self.subTest(chemin=path):
                self.assertEqual(self.reasons(pr_stub(), [path]),
                                 ["schéma ou migration Prisma"])

    # --- cumul ------------------------------------------------------------

    def test_tous_les_perimetres_cumules(self):
        paths = ["README.md",
                 "infra/terraform/prod/main.tf",
                 "apps/api/src/modules/payments/refund.service.ts",
                 "apps/api/prisma/schema.prisma"]
        self.assertEqual(
            self.reasons(pr_stub(), paths, {"mod:payments", "security"}),
            ["label mod:payments", "label security", "infra/terraform",
             "apps/api/src/modules/payments", "schéma ou migration Prisma"])

    def test_un_seul_motif_parmi_beaucoup_de_fichiers(self):
        paths = ["apps/web/src/app/page.tsx"] * 50 + ["infra/terraform/prod/main.tf"]
        self.assertEqual(self.reasons(pr_stub(), paths), ["infra/terraform"])

    # --- ce qui ne doit PAS déclencher ------------------------------------

    def test_pr_anodine(self):
        self.assertEqual(
            self.reasons(pr_stub(), ["README.md", "apps/web/src/app/page.tsx"]), [])

    def test_pr_sans_aucun_fichier(self):
        self.assertEqual(self.reasons(pr_stub(), []), [])

    def test_faux_amis_de_chemins(self):
        faux_amis = [
            "docs/infra/terraform-notes.md",                  # le mot, pas le dossier
            "infra/terraform-notes.md",                       # préfixe sans la barre
            "docs/infra/terraform/guide.md",                  # pas à la racine
            "apps/api/src/modules/payments-legacy/old.ts",    # voisin, pas le module
            "apps/web/src/lib/prismatic.ts",
            "docs/prisma/schema-explique.md",
            "apps/api/prisma/seed.ts",                        # ni schéma ni migration
        ]
        for path in faux_amis:
            with self.subTest(chemin=path):
                self.assertEqual(self.reasons(pr_stub(), [path]), [])

    # --- ne pas savoir vaut refus -----------------------------------------

    def test_liste_de_fichiers_indisponible(self):
        self.assertEqual(self.reasons(pr_stub(), None),
                         ["liste des fichiers indisponible"])

    def test_labels_indisponibles(self):
        self.assertEqual(self.reasons(pr_stub(), [], None),
                         ["labels de l'issue indisponibles"])

    def test_les_deux_indisponibles(self):
        self.assertEqual(self.reasons(pr_stub(), None, None),
                         ["labels de l'issue indisponibles",
                          "liste des fichiers indisponible"])

    def test_label_sensible_conserve_malgre_chemins_indisponibles(self):
        # Le motif tiré des labels est posé AVANT le retour anticipé des chemins.
        # Inversé, il disparaissait du verdict — constat de revue de #121.
        self.assertEqual(self.reasons(pr_stub(), None, {"security"}),
                         ["label security", "liste des fichiers indisponible"])

    # --- la chaîne entière, sans court-circuit ----------------------------

    def test_du_corps_de_la_pr_au_refus(self):
        fake = FakeGh([("issue view 42", completed(stdout="mod:payments\nP0\n"))])
        with mock.patch.object(pr_gate, "run", fake):
            reasons = pr_gate.sensitive(pr_stub(body="Fixed #42"), ["README.md"])
        self.assertEqual(reasons, ["label mod:payments"])


class TestSansLeWorkflowDAutoMerge(unittest.TestCase):
    """`assess()` — le workflow qui merge n'est pas un check qu'on attend.

    Déclenché par `pull_request_target`, son run est rattaché à la PR et
    s'inscrit dans ses checks. La barrière s'y voyait elle-même « en cours » et
    rendait 1 ; ce 1 avortait l'étape qui l'appelait, le job rougissait, et son
    échec devenait un check rouge de la PR. Rouge définitif : les réveils
    suivants viennent de `workflow_run`, rattaché à la branche par défaut, et ne
    rafraîchissent jamais l'entrée. Deux PR vertes en sont mortes — #145 et
    #146. Voir #147.
    """

    JOB = "Merger les PR étiquetées et vertes"

    def check(self, workflow, name, status="COMPLETED", conclusion="SUCCESS"):
        return {"__typename": "CheckRun", "workflowName": workflow, "name": name,
                "status": status, "conclusion": conclusion,
                "startedAt": "2026-08-25T10:00:00Z",
                "completedAt": "2026-08-25T10:01:00Z"}

    def assess(self, rollup):
        """`assess()` sur une PR par ailleurs irréprochable : seul le rollup varie."""
        pr = {"state": "OPEN", "isDraft": False, "baseRefName": "develop",
              "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
              "statusCheckRollup": rollup}
        return pr_gate.assess(pr, "develop", False)

    # --- ce que la barrière ne doit plus voir -----------------------------

    def test_son_propre_passage_en_cours_ne_l_attend_pas(self):
        code, _, checks = self.assess([
            self.check("CI", "Tests"),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB,
                       status="IN_PROGRESS", conclusion=None),
        ])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    def test_son_echec_deja_inscrit_ne_condamne_plus(self):
        # L'état exact de #145 et #146 : tout au vert, sauf le job qui merge.
        code, _, checks = self.assess([
            self.check("CI", "Tests"),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB, conclusion="FAILURE"),
        ])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    def test_rollup_sans_workflow_developpe(self):
        # Repli sur `name` quand le rollup ne développe pas `workflowName`.
        code, _, checks = self.assess([
            self.check("CI", "Tests"),
            {"__typename": "CheckRun", "name": pr_gate.MERGE_WORKFLOW,
             "status": "IN_PROGRESS", "conclusion": None},
        ])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    # --- ce qu'elle doit continuer de voir --------------------------------

    def test_les_autres_echecs_bloquent_toujours(self):
        code, message, _ = self.assess([
            self.check("CI", "Tests", conclusion="FAILURE"),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB, conclusion="FAILURE"),
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "1 check(s) en échec")

    def test_les_autres_attentes_font_toujours_attendre(self):
        code, message, _ = self.assess([
            self.check("CI", "Build", status="QUEUED", conclusion=None),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB, conclusion="FAILURE"),
        ])
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "1 check(s) en cours")

    def test_une_pr_reduite_a_ce_seul_check_reste_en_attente(self):
        # L'écarter ne doit pas fabriquer un vert : plus aucun check déclaré
        # signifie qu'aucun workflow n'a tourné, pas que tout va bien.
        code, message, checks = self.assess(
            [self.check(pr_gate.MERGE_WORKFLOW, self.JOB)])
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "aucun check déclaré pour l'instant")
        self.assertEqual(checks, [])

    def test_un_statut_externe_homonyme_est_conserve(self):
        # Un statut externe ne vient d'aucun workflow : l'écarter sur son seul
        # nom laisserait passer le rouge de quelqu'un d'autre.
        code, _, checks = self.assess([
            {"__typename": "StatusContext", "context": pr_gate.MERGE_WORKFLOW,
             "state": "FAILURE"},
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual([name for name, _, _ in checks], [pr_gate.MERGE_WORKFLOW])

    def test_un_check_d_application_homonyme_est_conserve(self):
        # Un check run posé par une application GitHub porte un `workflowName`
        # vide, pas absent : il ne vient d'aucun workflow, et l'écarter sur son
        # seul nom laisserait passer le rouge de quelqu'un d'autre.
        code, _, checks = self.assess([
            {"__typename": "CheckRun", "workflowName": "",
             "name": pr_gate.MERGE_WORKFLOW,
             "status": "COMPLETED", "conclusion": "FAILURE"},
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual([name for name, _, _ in checks], [pr_gate.MERGE_WORKFLOW])

    def test_rollup_vide_ou_absent(self):
        for rollup in ([], None):
            with self.subTest(rollup=rollup):
                self.assertEqual(pr_gate.without_merge_workflow(rollup), [])

    # --- la constante ne doit pas dériver du workflow ---------------------

    def test_le_nom_suit_celui_declare_par_le_workflow(self):
        """Une constante recopiée finit par désigner un workflow qui n'existe plus.

        Renommer `auto-merge.yml` sans toucher ici rétablirait la panne à
        l'identique, et rien ne le dirait avant qu'une PR verte ne meure.
        """
        source = (pr_gate.ROOT / ".github" / "workflows" / "auto-merge.yml"
                  ).read_text(encoding="utf-8")
        declared = re.search(r"(?m)^name:[ \t]*(.+?)[ \t]*$", source)
        self.assertIsNotNone(declared, "auto-merge.yml n'a plus de `name:`")
        self.assertEqual(declared.group(1), pr_gate.MERGE_WORKFLOW)


class TestAuthorisedScopes(unittest.TestCase):
    """`authorised_scopes()` — ce que l'opérateur a autorisé avant de partir.

    La variable dit ce qui a **déjà été répondu**, là où `SPA_UNATTENDED` dit
    seulement que personne ne peut répondre maintenant. Confondre les deux (#156)
    revenait à interdire tout merge sensible dès que l'opérateur s'absentait,
    c'est-à-dire à ne jamais se servir de la reprise automatique.
    """

    def scopes(self, value):
        with mock.patch.dict(os.environ, {pr_gate.AUTHORISED_ENV: value}):
            return pr_gate.authorised_scopes()

    def test_variable_absente_n_autorise_rien(self):
        with mock.patch.dict(os.environ, clear=True):
            self.assertEqual(pr_gate.authorised_scopes(), set())

    def test_variable_vide_n_autorise_rien(self):
        # Le superviseur la pose toujours, même vide : la lire comme « tout »
        # ferait de l'armement le plus prudent le plus permissif.
        self.assertEqual(self.scopes(""), set())

    def test_une_seule_cle(self):
        self.assertEqual(self.scopes("infra/terraform"), {"infra/terraform"})

    def test_plusieurs_cles_separees_par_des_virgules(self):
        self.assertEqual(self.scopes("infra/terraform,prisma"),
                         {"infra/terraform", "prisma"})

    def test_espaces_et_casse_tolerees(self):
        self.assertEqual(self.scopes("  INFRA/Terraform ,  prisma  "),
                         {"infra/terraform", "prisma"})

    def test_all_prend_tous_les_perimetres(self):
        self.assertEqual(self.scopes(pr_gate.ALL_SCOPES), set(pr_gate.SCOPE_KEYS))

    def test_cle_inconnue_n_ouvre_rien(self):
        # Fail-closed, comme `unattended()` : une faute de frappe rend la
        # barrière plus stricte, jamais plus permissive. Le refus franc se fait
        # à l'armement, là où quelqu'un peut encore corriger.
        self.assertEqual(
            pr_gate.blocking(["infra/terraform"], self.scopes("terraform")),
            ["infra/terraform"])


class TestBlocking(unittest.TestCase):
    """`blocking()` — ce qui reste à relire une fois les autorisations défalquées."""

    def test_sans_autorisation_tout_bloque(self):
        """Le comportement d'avant #156, et le défaut d'aujourd'hui."""
        reasons = ["label mod:payments", "infra/terraform",
                   "schéma ou migration Prisma"]
        self.assertEqual(pr_gate.blocking(reasons, set()), reasons)

    def test_le_perimetre_autorise_ne_bloque_plus(self):
        self.assertEqual(
            pr_gate.blocking(["infra/terraform"], {"infra/terraform"}), [])

    def test_autorisation_nommee_n_ouvre_que_ce_qu_elle_nomme(self):
        """Le cœur de l'arbitrage : ouvrir le socle sans ouvrir le paiement."""
        reasons = ["label mod:payments", "infra/terraform"]
        self.assertEqual(pr_gate.blocking(reasons, {"infra/terraform"}),
                         ["label mod:payments"])

    def test_tout_autorise_ne_bloque_rien(self):
        reasons = ["label mod:payments", "label security", "infra/terraform",
                   "apps/api/src/modules/payments", "schéma ou migration Prisma"]
        self.assertEqual(pr_gate.blocking(reasons, set(pr_gate.SCOPE_KEYS)), [])

    def test_pr_anodine_ne_bloque_pas(self):
        self.assertEqual(pr_gate.blocking([], set()), [])

    # --- l'ignorance ne se pré-autorise pas -------------------------------

    def test_fichiers_indisponibles_bloquent_meme_tout_autorise(self):
        """« Ne pas savoir vaut refus » survit à la pré-autorisation.

        L'opérateur a autorisé un périmètre **nommé** ; il n'a pas autorisé un
        périmètre inconnu. Laisser `all` couvrir l'ignorance rendrait le
        garde-fou muet précisément les jours de forte charge, quand `gh` est en
        limite de débit — c'est-à-dire le trou que #121 avait bouché.
        """
        self.assertEqual(
            pr_gate.blocking(["liste des fichiers indisponible"],
                             set(pr_gate.SCOPE_KEYS)),
            ["liste des fichiers indisponible"])

    def test_labels_indisponibles_bloquent_meme_tout_autorise(self):
        self.assertEqual(
            pr_gate.blocking(["labels de l'issue indisponibles"],
                             set(pr_gate.SCOPE_KEYS)),
            ["labels de l'issue indisponibles"])

    def test_un_motif_connu_autorise_ne_sauve_pas_un_motif_ignore(self):
        self.assertEqual(
            pr_gate.blocking(["label security", "liste des fichiers indisponible"],
                             set(pr_gate.SCOPE_KEYS)),
            ["liste des fichiers indisponible"])


class TestSensitiveKeys(unittest.TestCase):
    """`SENSITIVE_KEYS` — chaque motif refusable doit avoir une clé, ou aucune.

    Un motif que `sensitive()` sait produire mais que `SENSITIVE_KEYS` ignore est
    un périmètre impossible à pré-autoriser : l'opérateur le nommerait dans son
    armement sans que rien ne s'ouvre, et il ne l'apprendrait qu'en relisant un
    journal, des heures plus tard.
    """

    def reasons(self, pr, paths, from_issue=frozenset()):
        with mock.patch.object(pr_gate, "issue_labels", return_value=from_issue):
            return pr_gate.sensitive(pr, paths)

    def test_chaque_motif_reel_a_une_cle(self):
        paths = ["infra/terraform/prod/main.tf",
                 "apps/api/src/modules/payments/refund.service.ts",
                 "apps/api/prisma/schema.prisma"]
        produced = self.reasons(pr_stub(), paths, set(pr_gate.SENSITIVE_LABELS))
        # Le jeu ci-dessus couvre bien tous les périmètres, sans quoi le test
        # passerait en n'en vérifiant qu'une partie.
        self.assertEqual(len(produced), len(pr_gate.SCOPE_KEYS))
        for reason in produced:
            with self.subTest(motif=reason):
                self.assertIn(reason, pr_gate.SENSITIVE_KEYS)

    def test_les_motifs_d_ignorance_n_ont_pas_de_cle(self):
        for reason in ("liste des fichiers indisponible",
                       "labels de l'issue indisponibles"):
            with self.subTest(motif=reason):
                self.assertNotIn(reason, pr_gate.SENSITIVE_KEYS)

    def test_aucune_cle_en_trop(self):
        """Une clé qui ne correspond à aucun motif serait une autorisation qui
        n'autorise rien — annoncée à l'opérateur dans l'aide de l'armement."""
        self.assertEqual(len(pr_gate.SCOPE_KEYS), len(pr_gate.SENSITIVE_KEYS))
        self.assertEqual(
            len(pr_gate.SCOPE_KEYS),
            len(pr_gate.SENSITIVE_LABELS) + len(pr_gate.SENSITIVE_PREFIXES) + 1)


class TestSensitiveScopes(unittest.TestCase):
    """`SENSITIVE_SCOPES` — le message d'armement doit décrire les vrais refus.

    Une liste recopiée à la main finit par décrire autre chose que ce que la
    barrière refuse, et c'est le message que l'opérateur ne peut pas vérifier :
    il est lu à l'instant où il cesse de regarder.
    """

    def test_chaque_perimetre_est_annonce(self):
        for name in pr_gate.SENSITIVE_LABELS:
            self.assertIn("label " + name, pr_gate.SENSITIVE_SCOPES)
        for prefix in pr_gate.SENSITIVE_PREFIXES:
            self.assertIn(prefix.rstrip("/"), pr_gate.SENSITIVE_SCOPES)
        self.assertIn("Prisma", pr_gate.SENSITIVE_SCOPES)

    def test_rien_de_plus_que_ce_qui_est_refuse(self):
        annonces = pr_gate.SENSITIVE_SCOPES.split(", ")
        self.assertEqual(
            len(annonces),
            len(pr_gate.SENSITIVE_LABELS) + len(pr_gate.SENSITIVE_PREFIXES) + 1)


if __name__ == "__main__":
    unittest.main()
